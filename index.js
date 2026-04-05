#!/usr/bin/env node
'use strict';

const https = require('https');
const { version } = require('./package.json');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = 'https://graph.threads.net/v1.0';
const MIN_VIEWS_FOR_FLAG = 100; // ignore very-low-reach posts when flagging

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { format: 'terminal', days: 30, threshold: 0.5 };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      console.log(version);
      process.exit(0);
    }
    if (arg.startsWith('--format=')) {
      opts.format = arg.split('=')[1];
      if (!['terminal', 'json'].includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Use "terminal" or "json".`);
        process.exit(1);
      }
    } else if (arg.startsWith('--days=')) {
      opts.days = parseInt(arg.split('=')[1], 10);
      if (isNaN(opts.days) || opts.days < 1) {
        console.error('--days must be a positive integer.');
        process.exit(1);
      }
    } else if (arg.startsWith('--threshold=')) {
      opts.threshold = parseFloat(arg.split('=')[1]);
      if (isNaN(opts.threshold) || opts.threshold <= 0 || opts.threshold >= 1) {
        console.error('--threshold must be a number between 0 and 1 (e.g. 0.5).');
        process.exit(1);
      }
    } else {
      console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
      process.exit(1);
    }
  }

  return opts;
}

function printUsage() {
  console.log(`
threads-suppression-tracker v${version}

Detect potential algorithmic suppression on Threads by comparing
per-post engagement rates against your own baseline.

USAGE
  threads-suppression-tracker [options]

OPTIONS
  --format=terminal|json  Output format (default: terminal)
  --days=N                Look-back window in days (default: 30)
  --threshold=N           Flag posts below N * median rate (default: 0.5)
  --help, -h              Show this help message
  --version, -v           Show version number

ENVIRONMENT
  THREADS_ACCESS_TOKEN    Required. Your Threads API access token.

EXAMPLES
  export THREADS_ACCESS_TOKEN=your_token
  threads-suppression-tracker
  threads-suppression-tracker --format=json | jq .
  threads-suppression-tracker --days=14 --threshold=0.4
`.trim());
}

// ---------------------------------------------------------------------------
// HTTP helper with rate-limit retries
// ---------------------------------------------------------------------------

function makeRequest(path, token, retries = 3) {
  const url = `${API_BASE}${path}`;
  const options = { headers: { 'Authorization': `Bearer ${token}` }, timeout: 15000 };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', async () => {
        // Rate-limited or transient server error — back off and retry
        if ((res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 599)) && retries > 0) {
          const wait = parseRetryAfter(res.headers['retry-after']) || Math.pow(2, 3 - retries);
          await delay(wait * 1000);
          return resolve(makeRequest(path, token, retries - 1));
        }

        try {
          const json = JSON.parse(body);
          if (json.error) {
            if (json.error.code === 190) {
              return reject(new Error(
                'Access token is invalid or expired. Generate a new one at https://developers.facebook.com/tools/explorer/'
              ));
            }
            return reject(new Error(json.error.message));
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse API response (HTTP ${res.statusCode})`));
        }
      });
    }).on('timeout', function() { this.destroy(); }).on('error', async (err) => {
      if (retries > 0) {
        await delay(Math.pow(2, 3 - retries) * 1000);
        return resolve(makeRequest(path, token, retries - 1));
      }
      reject(err);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds;
  // Handle HTTP-date format (e.g. "Fri, 31 Dec 2026 23:59:59 GMT")
  const date = new Date(header);
  if (!isNaN(date.getTime())) return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
  return null;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchPosts(token, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const posts = [];
  let url = '/me/threads?fields=id,text,timestamp&limit=50';

  while (url) {
    const feed = await makeRequest(url, token);
    const page = (feed.data || []).filter((p) => new Date(p.timestamp) >= since);
    posts.push(...page);

    // Stop paginating if we've gone past the look-back window
    if (page.length < (feed.data || []).length) break;

    const cursor = feed.paging?.cursors?.after;
    url = cursor ? `/me/threads?fields=id,text,timestamp&limit=50&after=${encodeURIComponent(cursor)}` : null;
  }

  return posts;
}

async function fetchInsights(token, posts) {
  const enriched = [];

  for (const post of posts) {
    try {
      const ins = await makeRequest(
        `/${encodeURIComponent(post.id)}/insights?metric=views,likes,reposts,replies`,
        token
      );
      const m = {};
      (ins.data || []).forEach((x) => {
        m[x.name] = x.values?.[0]?.value ?? x.value ?? 0;
      });

      const views = m.views || 0;
      const likes = m.likes || 0;
      const reposts = m.reposts || 0;
      const replies = m.replies || 0;
      const engagement = likes + reposts + replies;
      const engagementRate = views > 0 ? parseFloat((engagement / views * 100).toFixed(2)) : 0;

      enriched.push({
        id: post.id,
        date: new Date(post.timestamp).toISOString().split('T')[0],
        text: post.text || '',
        views,
        likes,
        reposts,
        replies,
        engagement,
        engagementRate,
      });

      await delay(100); // gentle rate-limit spacing
    } catch (e) {
      process.stderr.write(`Warning: failed to get insights for post ${post.id}: ${e.message}\n`);
    }
  }

  return enriched.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function calculateBaseline(posts) {
  const rates = posts.filter((p) => p.views > 0).map((p) => p.engagementRate);
  if (rates.length === 0) return { mean: 0, median: 0 };

  const mean = parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2));
  const sorted = [...rates].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = parseFloat((sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  return { mean, median };
}

function detectSuppression(posts, baseline, threshold) {
  const cutoff = baseline.median * threshold;
  return posts.filter((p) => p.engagementRate < cutoff && p.views >= MIN_VIEWS_FOR_FLAG);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTerminal(results) {
  const { posts, baseline, suppressed, opts } = results;
  const suppressedIds = new Set(suppressed.map((p) => p.id));
  const lines = [];

  lines.push('');
  lines.push(`Found ${posts.length} posts in last ${opts.days} days`);
  lines.push('');
  lines.push('BASELINE METRICS');
  lines.push('='.repeat(80));
  lines.push(`Average engagement rate: ${baseline.mean}%`);
  lines.push(`Median engagement rate:  ${baseline.median}%`);
  lines.push('');
  lines.push('POST PERFORMANCE');
  lines.push('='.repeat(80));
  lines.push('Date       |   Views |  Eng. | Rate  | Text (preview)');
  lines.push('-----------|---------|-------|-------|' + '-'.repeat(40));

  for (const p of posts) {
    const flag = suppressedIds.has(p.id) ? '>>' : '  ';
    lines.push(
      `${flag} ${p.date} | ${String(p.views).padStart(7)} | ` +
      `${String(p.engagement).padStart(5)} | ${String(p.engagementRate).padStart(5)}% | ${p.text.replace(/\n/g, ' ').slice(0, 60)}`
    );
  }

  lines.push('');

  if (suppressed.length > 0) {
    lines.push('POTENTIAL SUPPRESSION DETECTED');
    lines.push('='.repeat(80));
    lines.push(
      `${suppressed.length} post(s) with views >= ${MIN_VIEWS_FOR_FLAG} ` +
      `but engagement rate below ${(baseline.median * opts.threshold).toFixed(2)}% (${opts.threshold * 100}% of median):`
    );
    lines.push('');

    for (const p of suppressed) {
      lines.push(`  ${p.date}: ${p.views} views, ${p.engagement} engagement (${p.engagementRate}%)`);
      lines.push(`  "${p.text.replace(/\n/g, ' ').slice(0, 60)}..."`);
      lines.push('');
    }

    lines.push('Analysis:');
    lines.push(`- Baseline engagement rate: ~${baseline.median}%`);
    lines.push(`- Suppressed posts: ${(suppressed.length / posts.length * 100).toFixed(0)}% of total`);
    lines.push('- Pattern: views present WITHOUT proportional engagement');
    lines.push('- This may indicate algorithmic throttling (shown but not promoted)');
  } else {
    lines.push('NO SUPPRESSION DETECTED');
    lines.push('='.repeat(80));
    lines.push('Engagement rates are consistent with baseline.');
  }

  lines.push('');
  lines.push('RECOMMENDATION:');
  if (suppressed.length > 3) {
    lines.push('- Multiple posts show suppression pattern');
    lines.push('- Try varying post formats (text-only, images, timing)');
    lines.push('- Check if certain topics/keywords trigger throttling');
    lines.push('- Consider cross-posting to Bluesky for comparison data');
  } else if (suppressed.length > 0) {
    lines.push('- Isolated suppression incidents detected');
    lines.push('- Monitor whether the pattern continues');
    lines.push('- Content resonance still matters — aim for timely + relatable');
  } else {
    lines.push('- No suppression detected — focus on content quality');
    lines.push('- Try more engaging hooks, questions, or strong takes');
    lines.push('- Timing matters: post when your audience is active');
  }

  lines.push('');
  return lines.join('\n');
}

function formatJSON(results) {
  const { posts, baseline, suppressed, opts } = results;
  return JSON.stringify({
    metadata: {
      generatedAt: new Date().toISOString(),
      days: opts.days,
      threshold: opts.threshold,
      postCount: posts.length,
      suppressedCount: suppressed.length,
    },
    baseline,
    suppressedPosts: suppressed,
    allPosts: posts,
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) {
    console.error(
      'Missing THREADS_ACCESS_TOKEN environment variable.\n\n' +
      'Set it before running:\n' +
      '  export THREADS_ACCESS_TOKEN=your_token_here\n\n' +
      'See README.md for instructions on obtaining a token.'
    );
    process.exit(1);
  }

  const posts = await fetchPosts(token, opts.days);
  const enriched = await fetchInsights(token, posts);
  const baseline = calculateBaseline(enriched);
  const suppressed = detectSuppression(enriched, baseline, opts.threshold);

  const results = { posts: enriched, baseline, suppressed, opts };

  console.log(opts.format === 'json' ? formatJSON(results) : formatTerminal(results));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

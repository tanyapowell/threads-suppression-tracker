# Threads Suppression Tracker

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Detect potential algorithmic suppression on Threads by analysing your post engagement metrics against your own baseline. Zero dependencies.

> **Disclaimer:** This tool identifies statistical outliers — posts with unusually low engagement relative to your own average. It cannot prove algorithmic suppression. Many factors affect engagement (timing, topic, audience mood). Use the results as an analytical starting point, not a conclusion.

## Quick Start

```bash
export THREADS_ACCESS_TOKEN=your_token_here
npx threads-suppression-tracker
```

## Getting a Threads API Token

1. Go to [Meta for Developers](https://developers.facebook.com/) and create a developer account (or log in).
2. Create a new app and select **Business** as the app type.
3. In the app dashboard, add the **Threads API** product.
4. Go to **Threads API > Settings** and configure your redirect URI.
5. Under **Threads API > Tools**, generate a user access token. The required scopes are:
   - `threads_basic` — read your profile and posts
   - `threads_content_publish` — not strictly required, but often bundled
6. Copy the token. It is a long string starting with `THQC...`

**Token expiration:** Short-lived tokens expire in ~1 hour. Exchange for a long-lived token (60 days) via the [token exchange endpoint](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens). You can also use the [Graph API Explorer](https://developers.facebook.com/tools/explorer/) for quick testing.

## Installation

**Option 1 — Run directly (no install):**
```bash
npx threads-suppression-tracker
```

**Option 2 — Install globally:**
```bash
npm install -g threads-suppression-tracker
threads-suppression-tracker
```

**Option 3 — Clone and run:**
```bash
git clone https://github.com/tanyapowell/threads-suppression-tracker.git
cd threads-suppression-tracker
node index.js
```

## Usage

```
threads-suppression-tracker [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--format=terminal\|json` | `terminal` | Output format |
| `--days=N` | `30` | Number of days to look back |
| `--threshold=N` | `0.5` | Flag posts below N &times; median engagement rate |
| `--help`, `-h` | | Show help message |
| `--version`, `-v` | | Show version |

### Examples

```bash
# Default terminal report
threads-suppression-tracker

# JSON output, pipe to jq
threads-suppression-tracker --format=json | jq '.suppressedPosts'

# Last 14 days, stricter threshold
threads-suppression-tracker --days=14 --threshold=0.4

# Save JSON report to file
threads-suppression-tracker --format=json > report.json
```

## Understanding the Results

### Engagement rate

```
engagement rate = (likes + reposts + replies) / views * 100
```

Each post gets an engagement rate as a percentage. A post with 50 likes + reposts + replies and 1,000 views has a 5.0% engagement rate.

### Baseline

Your **median** engagement rate across all posts in the look-back window. The median is used instead of the mean because it is more resistant to outliers (one viral post won't skew it).

### What "suppressed" means here

A post is flagged when **both** conditions are true:

1. Its engagement rate is below `threshold * median` (default: 50% of your median)
2. It received at least 100 views (to exclude posts that simply haven't been seen yet)

This pattern — **views present but engagement absent** — can indicate the post was shown in feeds but de-prioritised (e.g. placed lower, excluded from recommendations, or not pushed to followers' feeds).

### Common false positives

Not every flagged post is being suppressed. Consider:

- **Timing** — posted when your audience was inactive
- **Content** — less engaging topic, no hook, no call to action
- **Format** — text-only vs image vs carousel can perform differently
- **Competition** — high-traffic periods dilute attention

Use the data to spot patterns, not to draw conclusions from a single post.

## Example Output

### Terminal

```
Found 6 posts in last 30 days

BASELINE METRICS
================================================================================
Average engagement rate: 4.12%
Median engagement rate:  3.85%

POST PERFORMANCE
================================================================================
Date       |   Views |  Eng. | Rate  | Text (preview)
-----------|---------|-------|-------|----------------------------------------
>> 2026-03-28 |    4200 |    25 |   0.6% | Thread about algorithmic transparency...
   2026-03-25 |    1800 |    65 |  3.61% | Really enjoyed this conversation about...
   2026-03-20 |    2400 |    92 |  3.83% | Quick tip: if your engagement drops...
>> 2026-03-15 |    3100 |    16 |  0.52% | Here is what we found when we analysed...
   2026-03-10 |     950 |    55 |  5.79% | The community response to our findings...
   2026-03-08 |    1600 |    68 |  4.25% | New blog post is live breaking down...

POTENTIAL SUPPRESSION DETECTED
================================================================================
2 post(s) with views >= 100 but engagement rate below 1.93% (50% of median):

  2026-03-28: 4200 views, 25 engagement (0.6%)
  "Thread about algorithmic transparency..."

  2026-03-15: 3100 views, 16 engagement (0.52%)
  "Here is what we found when we analysed..."
```

### JSON

See [`example-output.json`](example-output.json) for the full JSON structure.

## How It Works

1. **Fetch** your last N days of Threads posts via the Threads API
2. **Enrich** each post with engagement metrics (views, likes, reposts, replies)
3. **Calculate** your baseline median engagement rate
4. **Flag** posts where engagement is disproportionately low relative to views
5. **Report** results in terminal or JSON format

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

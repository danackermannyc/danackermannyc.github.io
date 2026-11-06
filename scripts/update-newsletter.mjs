// Pulls the latest posts from the Substack RSS feed and rewrites the
// newsletter cards in index.html between the NEWSLETTER:START/END markers.
// Runs in GitHub Actions (Node 20+, no dependencies).

import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://danackerman.substack.com";
const FILE = new URL("../index.html", import.meta.url);
const COUNT = 4;
const BROWSER_HEADERS = {
  "User-Agent": "danackerman-site-updater (+https://github.com/danackermannyc/danackermannyc.github.io)",
};

const decodeEntities = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
   .replace(/&amp;/g, "&");

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")).trim();
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Turn any Substack image URL into a 640px-wide CDN version.
const sizedImage = (url) => {
  if (!url) return "";
  const m = url.match(/https(?::\/\/|%3A%2F%2F)substack-post-media\.s3\.amazonaws\.com(?:\/|%2F)[^"'\s?&]+/i);
  if (!m) return url;
  const raw = decodeURIComponent(m[0]);
  return `https://substackcdn.com/image/fetch/w_640,f_auto,q_auto:good/${encodeURIComponent(raw)}`;
};

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Strategy 1: RSS feed.
async function fromRss() {
  const res = await fetch(`${BASE}/feed`, { headers: { ...BROWSER_HEADERS, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" } });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, COUNT).map(([, block]) => {
    const enclosure = block.match(/<enclosure[^>]*url="([^"]+)"/);
    return {
      title: tag(block, "title"),
      link: tag(block, "link"),
      description: tag(block, "description").replace(/<[^>]+>/g, ""),
      image: sizedImage(enclosure ? decodeEntities(enclosure[1]) : ""),
      date: fmtDate(tag(block, "pubDate")),
    };
  });
}

// Strategy 2: Substack's public archive API (JSON).
async function fromApi() {
  const res = await fetch(`${BASE}/api/v1/archive?sort=new&offset=0&limit=${COUNT}`, { headers: { ...BROWSER_HEADERS, Accept: "application/json" } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const posts = await res.json();
  return posts.slice(0, COUNT).map((p) => ({
    title: p.title || "",
    link: p.canonical_url || `${BASE}/p/${p.slug}`,
    description: p.subtitle || p.description || "",
    image: sizedImage(p.cover_image || ""),
    date: fmtDate(p.post_date),
  }));
}

let items = [];
for (const [name, fn] of [["RSS", fromRss], ["API", fromApi]]) {
  try {
    items = (await fn()).filter((p) => p.title && p.link);
    if (items.length) { console.log(`Fetched ${items.length} posts via ${name}.`); break; }
  } catch (err) {
    console.log(`${name} failed: ${err.message}`);
  }
}

if (items.length === 0) {
  // Don't block the deploy: keep the posts already on the page.
  console.log("::warning::Could not fetch Substack posts; leaving existing posts in place.");
  process.exit(0);
}

const cards = items.map((p) => `      <a class="post reveal" href="${esc(p.link)}" target="_blank" rel="noopener">
        <div class="post-img">${p.image ? `<img loading="lazy" alt="" src="${esc(p.image)}">` : ""}</div>
        <div class="post-body"><span class="mono">${esc(p.date)}</span><h4>${esc(p.title)}</h4><p>${esc(p.description)}</p></div>
      </a>`).join("\n");

const html = await readFile(FILE, "utf8");
const start = /(<!-- NEWSLETTER:START[^>]*-->)[\s\S]*?(\s*<!-- NEWSLETTER:END -->)/;
if (!start.test(html)) throw new Error("NEWSLETTER markers not found in index.html");

const updated = html.replace(start, (_, open, close) => `${open}\n${cards}${close}`);
if (updated === html) {
  console.log("Newsletter section already up to date.");
} else {
  await writeFile(FILE, updated);
  console.log(`Updated newsletter section with ${items.length} posts:`);
  items.forEach((p) => console.log(` - ${p.date}: ${p.title}`));
}

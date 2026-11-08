/**
 * Builds the card deck from open-access museum art.
 * Met Museum: objects flagged isPublicDomain (CC0). Wikimedia Commons: files whose
 * licence string is public domain / CC0. Nothing else is downloaded.
 * Output: public/cards/<id>.webp (600x900) + data/cards.manifest.json
 */
import sharp from "sharp";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const CARD_DIR = path.join(ROOT, "public", "cards");
const MANIFEST = path.join(ROOT, "data", "cards.manifest.json");
const UA = "storycards-deck/1.0 (local party game; non-commercial)";

const TARGET = Number(process.env.TARGET ?? 420);
const CONCURRENCY = 6;
const W = 600, H = 900;

type Candidate = {
  id: string;
  url: string;
  title: string;
  artist: string;
  license: string;
  source: string;
  origin: "met" | "commons";
};

const MET_TERMS = [
  "dream", "surreal", "allegory", "myth", "angel", "mask", "moon", "forest",
  "storm", "mirror", "shadow", "garden", "bird", "beast", "voyage", "carnival",
  "night", "fable", "ghost", "clown", "tower", "door", "key", "fish",
  "circus", "puppet", "theatre", "snow", "flood", "ruins", "lantern", "tiger",
  "vision", "paradise", "underworld", "fountain", "rider", "crown", "sleep", "fire",
];

const COMMONS_QUERIES = [
  'incategory:"Paintings by Odilon Redon"',
  'incategory:"Paintings by Hieronymus Bosch"',
  'incategory:"Paintings by Gustave Moreau"',
  'incategory:"Paintings by Henri Rousseau"',
  'incategory:"Paintings by William Blake"',
  'incategory:"Paintings by Hugo Simberg"',
  'incategory:"Paintings by Elihu Vedder"',
  'incategory:"Paintings by Jan Toorop"',
  'incategory:"Paintings by Franz von Stuck"',
  'incategory:"Paintings by Carl Spitzweg"',
  "Arthur Rackham illustration",
  "Ivan Bilibin illustration",
  "Edmund Dulac illustration",
  "Kay Nielsen illustration",
  "John Bauer illustration",
  "Gustave Dore engraving",
  "Arnold Bocklin painting",
  "Felicien Rops",
  "Grandville illustration",
  "Harry Clarke illustration",
  "Warwick Goble illustration",
  "Virginia Frances Sterrett",
  "Sidney Sime illustration",
  "Charles Robinson fairy tale illustration",
  "Walter Crane illustration",
  "Aubrey Beardsley illustration",
  "symbolist painting",
  "surrealist painting public domain",
  "fairy tale illustration colour plate",
  "fantasy illustration 1900 book plate",
  "Japanese ukiyo-e ghost",
  "medieval manuscript marginalia beast",
  "alchemical emblem engraving",
  "tarot card 1900",
  "circus poster lithograph 1900",
  "magic lantern slide fantasy",
  "vintage balloon flight engraving",
  "shadow puppet figure",
  "carnival mask engraving",
  "dream vision engraving",
];

const stripTags = (s: string) =>
  (s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

let metGate = Promise.resolve();
/** serialise a small delay between Met calls; their edge throttles bursts hard */
async function polite(ms: number) {
  const prev = metGate;
  let release: () => void;
  metGate = new Promise<void>((r) => (release = r));
  await prev;
  setTimeout(() => release!(), ms);
}

async function jget(url: string, tries = 5): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) throw new Error("http " + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise((res) => setTimeout(res, 1200 * (i + 1) * (i + 1)));
    }
  }
  return null;
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try { await fn(items[i], i); } catch { /* candidate dropped */ }
      }
    })
  );
}

async function collectMet(): Promise<Candidate[]> {
  const ids = new Set<number>();
  for (const term of MET_TERMS) {
    const u = `https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=${encodeURIComponent(term)}&isPublicDomain=true&hasImages=true`;
    const d = await jget(u);
    for (const id of (d?.objectIDs ?? []).slice(0, 45)) ids.add(id);
    process.stdout.write(`  met "${term}" -> ${ids.size} pooled\r`);
  }
  console.log(`\n  met: ${ids.size} candidate objects`);

  const out: Candidate[] = [];
  let seen = 0;
  // the v1.1 search ignores isPublicDomain, so every object is re-checked here
  await pool([...ids], 3, async (id) => {
    await polite(60);
    const o = await jget(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
    if (++seen % 50 === 0) process.stdout.write(`  met detail ${seen}/${ids.size} kept ${out.length}\r`);
    if (!o?.isPublicDomain) return;
    const url = o.primaryImageSmall || o.primaryImage;   // web-large derivative, not the raw master
    if (!url) return;
    out.push({
      id: `met-${id}`,
      url,
      title: stripTags(o.title || "Untitled"),
      artist: stripTags(o.artistDisplayName || o.culture || "Unknown"),
      license: "CC0 (Met Open Access)",
      source: o.objectURL || `https://www.metmuseum.org/art/collection/search/${id}`,
      origin: "met",
    });
  });
  console.log(`  met: ${out.length} public-domain images with usable files`);
  return out;
}

async function collectCommons(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (const q of COMMONS_QUERIES) {
    const u =
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2` +
      `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=50` +
      `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1100`;
    const d = await jget(u);
    for (const p of d?.query?.pages ?? []) {
      if (seen.has(p.pageid)) continue;
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const lic = String(ii.extmetadata?.LicenseShortName?.value ?? "").toLowerCase();
      if (!(lic.includes("public domain") || lic.includes("cc0") || lic === "pd")) continue;
      const url = ii.thumburl || ii.url;
      if (!url || !/\.(jpe?g|png)$/i.test(String(p.title))) continue;
      seen.add(p.pageid);
      out.push({
        id: `wc-${p.pageid}`,
        url,
        title: stripTags(String(p.title).replace(/^File:/, "").replace(/\.[a-z]+$/i, "")),
        artist: stripTags(String(ii.extmetadata?.Artist?.value ?? "Unknown")),
        license: stripTags(String(ii.extmetadata?.LicenseShortName?.value ?? "Public domain")),
        source: ii.descriptionurl || `https://commons.wikimedia.org/?curid=${p.pageid}`,
        origin: "commons",
      });
    }
    process.stdout.write(`  commons "${q.slice(0, 28)}" -> ${out.length} pooled\r`);
  }
  console.log(`\n  commons: ${out.length} public-domain files`);
  return out;
}

async function process1(c: Candidate): Promise<any | null> {
  const file = `${c.id}.webp`;
  const dest = path.join(CARD_DIR, file);
  if (!existsSync(dest)) {
    const r = await fetch(c.url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength < 8000) return null;
    const meta = await sharp(buf).metadata();
    if ((meta.width ?? 0) < 400 || (meta.height ?? 0) < 400) return null;
    await sharp(buf)
      .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
      .webp({ quality: 78 })
      .toFile(dest);
  }
  return { id: c.id, file: `cards/${file}`, title: c.title, artist: c.artist, license: c.license, source: c.source, origin: c.origin };
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  await mkdir(CARD_DIR, { recursive: true });
  await mkdir(path.dirname(MANIFEST), { recursive: true });

  // resume: anything already downloaded and still listed stays in the deck
  let existing: any[] = [];
  if (existsSync(MANIFEST)) {
    try {
      const prev = JSON.parse(await Bun.file(MANIFEST).text());
      existing = (prev.cards ?? []).filter((c: any) => existsSync(path.join(ROOT, "public", c.file)));
    } catch { existing = []; }
  }
  const have = new Set(existing.map((c) => c.id));
  console.log(`Resuming with ${existing.length} cards already on disk.`);

  if (existing.length >= TARGET) {
    await writeFile(MANIFEST, JSON.stringify({ generated: new Date().toISOString(), count: existing.length, cards: existing }, null, 2));
    console.log(`Already at target (${existing.length}). Nothing to do.`);
    return;
  }

  console.log(`Collecting candidates (target ${TARGET} cards)...`);
  const [met, commons] = await Promise.all([collectMet(), collectCommons()]);

  // interleave the two sources so the deck is stylistically mixed
  const a = shuffle(met), b = shuffle(commons);
  const queue: Candidate[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) queue.push(a[i]);
    if (b[i]) queue.push(b[i]);
  }

  const cards: any[] = [...existing];
  let done = 0, failed = 0;
  const fresh = queue.filter((c) => !have.has(c.id));
  console.log(`  ${fresh.length} new candidates to try (${queue.length - fresh.length} already held)`);
  await pool(fresh, CONCURRENCY, async (c) => {
    if (cards.length >= TARGET) return;
    const rec = await process1(c);
    if (rec) { cards.push(rec); } else { failed++; }
    done++;
    if (done % 10 === 0) process.stdout.write(`  processed ${done}/${fresh.length}  kept ${cards.length}  failed ${failed}\r`);
  });

  const final = cards.slice(0, TARGET);
  await writeFile(MANIFEST, JSON.stringify({ generated: new Date().toISOString(), count: final.length, cards: final }, null, 2));
  const files = (await readdir(CARD_DIR)).filter((f) => f.endsWith(".webp"));
  console.log(`\nDone. ${final.length} cards in manifest, ${files.length} webp files on disk.`);
  console.log(`  ${MANIFEST}`);
  console.log(`  ${CARD_DIR}`);
}

main();

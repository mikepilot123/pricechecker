/* ============================================================
   Device search — what staff mean, not the exact name.
   ------------------------------------------------------------
   Used by every device picker (Check In, Appointments, Leads) and the
   Prices tab search. Instead of looking for the typed text as one piece,
   each word typed has to fit somewhere in the device's name, in any order:

     "macbook pro 2020"  → MacBook Pro 13-inch Intel 2020 (A2289),
                           MacBook Pro 13-inch M1 2020 / M2 2022 (A2338)…
     "mbp 2014"          → MacBook Pro 13-inch Retina Late 2013-2015 (A1502)…
     "air m2", "a2337", "13in mba", "iphone 13 promax", "macbok"…

   - Years inside a range count: 2014 finds "Late 2013-2015".
   - Short forms: mbp / mba, 13in / 13" / 13 inch, promax, techno/tecno.
   - A word can be the start of a longer one ("mac", "a23"), and a small
     typo in a longer word still matches ("macbok", "samsnug").
   - Best matches come first; the closest name to what was typed wins.
     When nothing fits every word, the pickers still suggest the nearest
     devices (all but one word matching) rather than showing nothing.
   ============================================================ */
(function () {
  // Words that say nothing about which device it is.
  const FILLER = new Set(["inch", "inches", "in", "laptop", "notebook", "computer", "the", "model", "my", "a", "an"]);

  const SHORT_FORMS = [
    [/\bmbp\b/g, "macbook pro"],
    [/\bmba\b/g, "macbook air"],
    [/\bmac\s+book\b/g, "macbook"],
    [/\bmacbookpro\b/g, "macbook pro"],
    [/\bmacbookair\b/g, "macbook air"],
    [/\bpromax\b/g, "pro max"],
    [/\btechno\b/g, "tecno"],
  ];

  // Lowercase words, with sizes ("13-inch", 13", 13in) evened out to "13"
  // and the short forms above spelled out.
  function words(text) {
    let t = String(text || "").toLowerCase()
      .replace(/[″”“]/g, '"')
      .replace(/(\d)\s*(?:"|''|-?\s*inch(?:es)?\b|in\b)/g, "$1 inch ");
    SHORT_FORMS.forEach(([re, to]) => { t = t.replace(re, to); });
    return t.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  }

  // Every year a name covers: "2016-2017" and "Late 2013-2015" cover the
  // years in between too.
  function yearsOf(name) {
    const years = new Set();
    const text = String(name || "");
    text.replace(/\b((?:19|20)\d{2})\s*[-–]\s*(?:(?:early|mid|late)\s+)?((?:19|20)\d{2})\b/gi, (_, a, b) => {
      for (let y = Number(a); y <= Number(b); y += 1) years.add(String(y));
      return _;
    });
    (text.match(/\b(?:19|20)\d{2}\b/g) || []).forEach((y) => years.add(y));
    return years;
  }

  // Edit distance, stopping early once it's past 1 — only "one typo" counts.
  function withinOneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i += 1; j += 1; continue; }
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else { i += 1; j += 1; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  const indexCache = new Map();
  function indexOf(name) {
    let entry = indexCache.get(name);
    if (!entry) {
      entry = { tokens: words(name).filter((w) => w !== "inch"), years: yearsOf(name) };
      indexCache.set(name, entry);
      if (indexCache.size > 5000) indexCache.clear();
    }
    return entry;
  }

  // How well one typed word fits a name: 3 exact (or a year in its range),
  // 2 the start of a word, 1 one typo away, 0 not at all.
  function wordScore(word, entry) {
    if (entry.tokens.includes(word)) return 3;
    if (/^(?:19|20)\d{2}$/.test(word) && entry.years.has(word)) return 3;
    if (entry.tokens.some((t) => t.startsWith(word))) return 2;
    // Typos only in words: a number one digit off (2020 / 2026) is a
    // different device.
    if (word.length >= 4 && !/\d/.test(word)
        && entry.tokens.some((t) => t.length >= 4 && !/\d/.test(t) && withinOneEdit(word, t))) return 1;
    return 0;
  }

  function queryWords(query) {
    return words(query).filter((w) => !FILLER.has(w));
  }

  function scoreName(name, qWords) {
    const entry = indexOf(name);
    let matched = 0;
    let score = 0;
    qWords.forEach((w) => {
      const s = wordScore(w, entry);
      if (s) { matched += 1; score += s; }
    });
    // Fewer leftover words in the name = closer to what was typed.
    return { matched, score: score * 10 - Math.max(0, entry.tokens.length - qWords.length) };
  }

  /** True when every word typed fits the name (the Prices tab filter). */
  function matchesAll(name, query) {
    const qWords = queryWords(query);
    if (!qWords.length) return true;
    return scoreName(name, qWords).matched === qWords.length;
  }

  /**
   * The names that fit `query`, best first. With `fallback` (the default),
   * when nothing fits every word, the nearest names (all but one word
   * matching) are suggested instead of nothing.
   */
  function search(names, query, { fallback = true, limit = 60 } = {}) {
    const qWords = queryWords(query);
    const list = Array.isArray(names) ? names : [];
    if (!qWords.length) return list.slice();
    const scored = list.map((name, order) => ({ name, order, ...scoreName(name, qWords) }));
    const byRank = (a, b) => b.score - a.score || a.order - b.order;
    const full = scored.filter((s) => s.matched === qWords.length).sort(byRank);
    if (full.length || !fallback) return full.slice(0, limit).map((s) => s.name);
    const need = Math.max(1, qWords.length - 1);
    return scored.filter((s) => s.matched >= need).sort(byRank).slice(0, limit).map((s) => s.name);
  }

  window.RPC_DEVICE_SEARCH = { search, matchesAll };
})();

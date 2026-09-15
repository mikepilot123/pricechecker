// Pulls the text layer out of a supplier order PDF so the AI extraction in
// lib/parts-order-extraction.js can send ~1KB of text instead of a ~150KB
// base64 image of the same page. That's the difference between a request that
// comfortably fits the Gemini free tier and one that doesn't: fewer tokens,
// far less contention, and a task small models get right every time.
//
// Every supplier PDF seen so far (MobileSentrix, eBay) is a browser
// print-to-PDF and carries a real text layer. Anything that doesn't — a
// scanned or photographed order — returns "" here, and the caller falls back
// to sending the PDF itself for the model to read as an image.

// Chrome's print-to-PDF emits one text item per glyph with explicit
// positioning, so naive joining gives "S u b tot a l". Spacing has to be
// recovered from the geometry: a gap wider than a fraction of the line height
// is a real space, anything tighter is just kerning within a word.
const SPACE_GAP_RATIO = 0.18;
const LINE_BREAK_TOLERANCE = 3;
// Below this, assume there's no usable text layer (a scan yields a handful of
// stray characters at most) and let the caller send the image instead.
const MIN_USEFUL_CHARS = 200;

export async function extractPdfText(pdfBuffer) {
  let pdfjs;
  try {
    // Imported lazily so a PDF-parsing problem can never stop the API route
    // from loading — the image path still works without this.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    console.warn("[parts-pdf] pdfjs unavailable, falling back to image input:", err?.message);
    return "";
  }

  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      // Nothing here should reach out to the network or a font CDN.
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;

    let out = "";
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const { items } = await page.getTextContent();
      let prev = null;
      for (const item of items) {
        if (!item.str) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        if (prev) {
          if (Math.abs(y - prev.y) > LINE_BREAK_TOLERANCE) out += "\n";
          else if (x - (prev.x + prev.width) > (prev.height || 10) * SPACE_GAP_RATIO) out += " ";
        }
        out += item.str;
        prev = { x, y, width: item.width, height: item.height };
      }
      out += "\n";
    }
    await doc.destroy();

    const text = out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return text.length >= MIN_USEFUL_CHARS ? text : "";
  } catch (err) {
    console.warn("[parts-pdf] text extraction failed, falling back to image input:", err?.message);
    return "";
  }
}

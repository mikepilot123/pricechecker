// The invoice PDF, laid out like the shop's Zoho invoices.
//
// Shared by the browser (assets/invoice.js — Download/Share/attach PDF) and
// the server (api/invoice.js — the "View invoice" link in emails), so both
// always produce exactly the same file. Pure ES module with no imports: the
// caller passes in its jsPDF class (window.jspdf.jsPDF in the browser, the
// "jspdf" package in Node).

// Coordinates are A4 points, taken from the shop's Zoho invoice so the two
// look the same side by side.
const PAGE = { left: 46, right: 569, valueRight: 561, top: 50, bottom: 790 };
const INK = [51, 51, 51];
const MUTED = [102, 102, 102];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const money = (v) => num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const displayDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};

export function invoiceTotals(invoice) {
  const items = invoice.items || [];
  const subTotal = num(items.reduce((sum, it) => sum + num(it.qty || 1) * num(it.rate), 0));
  const paymentMade = num(invoice.paymentMade);
  return { subTotal, total: subTotal, paymentMade, balanceDue: num(subTotal - paymentMade) };
}

export function invoicePdfName(invoice) {
  return `${String(invoice.number || "invoice").replace(/[^\w.-]+/g, "_")}.pdf`;
}

/** Draws the invoice into a new A4 jsPDF document and returns it. */
export function drawInvoicePdf(JsPDF, invoice) {
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const totalsOf = invoiceTotals;
  const cur = invoice.currency || "TTD";
  const t = totalsOf(invoice);
  const b = invoice.business || {};
  const { left: L, right: R, valueRight: VR } = PAGE;

  const font = (style, size, color = INK) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  // From block
  font("bold", 10);
  doc.text(b.name || "JQ Electronics Ltd.", L, 68);
  font("normal", 9);
  let y = 80;
  for (const line of [...(b.addressLines || []), b.email].filter(Boolean)) {
    doc.text(String(line), L, y);
    y += 12;
  }

  // Title block
  font("normal", 28, [0, 0, 0]);
  doc.text("INVOICE", R, 87, { align: "right" });
  font("bold", 10);
  doc.text(`# ${invoice.number || ""}`, R, 105, { align: "right" });
  font("bold", 8);
  doc.text("Balance Due", R, 132, { align: "right" });
  font("bold", 12);
  doc.text(`${cur}${money(t.balanceDue)}`, R, 147, { align: "right" });

  // Dates + bill to
  const dateRows = [["Invoice Date :", displayDate(invoice.invoiceDate)], ["Terms :", invoice.terms || "Due on Receipt"], ["Due Date :", displayDate(invoice.dueDate)]];
  dateRows.forEach(([label, value], i) => {
    font("normal", 10);
    doc.text(label, 457, 189 + i * 21, { align: "right" });
    font("normal", 9);
    doc.text(String(value || ""), VR, 189 + i * 21, { align: "right" });
  });
  font("normal", 10);
  doc.text("Bill To", L, 222);
  font("bold", 9);
  doc.text(invoice.billTo?.name || "", L, 235);

  // Items table
  const drawHeader = (top) => {
    doc.setFillColor(60, 61, 58);
    doc.rect(L, top, R - L, 24, "F");
    doc.setDrawColor(90, 91, 88);
    doc.setLineWidth(0.5);
    [78, 380, 434, 490].forEach((x) => doc.line(x, top, x, top + 24));
    font("normal", 9, [255, 255, 255]);
    const base = top + 15;
    doc.text("#", 57, base);
    doc.text("Item & Description", 86, base);
    doc.text("Qty", 425, base, { align: "right" });
    doc.text("Rate", 482, base, { align: "right" });
    doc.text("Amount", VR, base, { align: "right" });
    return top + 24;
  };
  let rowTop = drawHeader(255);
  (invoice.items || []).forEach((item, i) => {
    font("normal", 9);
    const descLines = doc.splitTextToSize(item.description || "", 285);
    const detailLines = item.detail ? doc.splitTextToSize(item.detail, 285) : [];
    const lineCount = Math.max(1, descLines.length + detailLines.length);
    const height = 14 + (lineCount - 1) * 12 + 14;
    if (rowTop + height > PAGE.bottom) {
      doc.addPage();
      rowTop = drawHeader(PAGE.top);
    }
    let base = rowTop + 14;
    font("normal", 9);
    doc.text(String(i + 1), 58, base);
    doc.text(num(item.qty || 1).toFixed(2), 425, base, { align: "right" });
    doc.text(money(item.rate), 482, base, { align: "right" });
    doc.text(money(num(item.qty || 1) * num(item.rate)), VR, base, { align: "right" });
    descLines.forEach((line) => { doc.text(line, 86, base); base += 12; });
    font("normal", 9, MUTED);
    detailLines.forEach((line) => { doc.text(line, 86, base); base += 12; });
    rowTop += height;
    doc.setDrawColor(173, 173, 173);
    doc.setLineWidth(0.5);
    doc.line(L, rowTop, R, rowTop);
  });

  // Totals
  if (rowTop + 120 > PAGE.bottom) { doc.addPage(); rowTop = PAGE.top; }
  let ty = rowTop + 15;
  const totalRow = (label, value, { bold = false, color = INK } = {}) => {
    font(bold ? "bold" : "normal", 9);
    doc.text(label, 457, ty, { align: "right" });
    font(bold ? "bold" : "normal", 9, color);
    doc.text(value, VR, ty, { align: "right" });
    ty += 28;
  };
  totalRow("Sub Total", money(t.subTotal));
  totalRow("Total", `${cur}${money(t.total)}`, { bold: true });
  if (t.paymentMade) totalRow("Payment Made", `(-) ${money(t.paymentMade)}`, { color: [224, 43, 39] });
  doc.setFillColor(245, 244, 243);
  doc.rect(308, ty - 16, R - 308, 28, "F");
  totalRow("Balance Due", `${cur}${money(t.balanceDue)}`, { bold: true });

  // Notes
  const notes = String(invoice.notes || "").trim();
  if (notes) {
    let ny = ty + 32;
    if (ny + 40 > PAGE.bottom) { doc.addPage(); ny = PAGE.top; }
    font("normal", 10);
    doc.text("Notes", L, ny);
    ny += 16;
    font("normal", 8);
    for (const para of notes.split("\n")) {
      const lines = para.trim() ? doc.splitTextToSize(para, R - L) : [""];
      for (const line of lines) {
        if (ny > PAGE.bottom) { doc.addPage(); ny = PAGE.top; font("normal", 8); }
        if (line) doc.text(line, L, ny);
        ny += 10.4;
      }
    }
  }

  // Page numbers, bottom right like Zoho.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font("normal", 8);
    doc.text(String(p), 561, 809, { align: "right" });
  }
  doc.setProperties({ title: `Invoice ${invoice.number || ""}`, author: b.name || "JQ Electronics" });
  return doc;
}

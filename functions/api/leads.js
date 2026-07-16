import { ensureSchema } from "../_lib/db.js";
import { addLead, addLeadNote, deleteLead, listLeadNotes, listLeads, updateLead } from "../_lib/leads.js";
import { checkPin, jsonResponse, preflightResponse } from "../_lib/security.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return preflightResponse(request);

  const body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await readBody(request);
  const denied = checkPin(request, body.pin, env);
  if (denied) {
    return jsonResponse({ ok: false, error: denied.error }, request, denied.status);
  }

  const action = body.action || "list";
  try {
    await ensureSchema();
    if (action === "list") {
      return jsonResponse({ ok: true, leads: await listLeads({ includeDeleted: !!body.includeDeleted }) }, request);
    }
    if (action === "add") {
      return jsonResponse({ ok: true, lead: await addLead(body) }, request);
    }
    if (action === "update") {
      return jsonResponse({ ok: true, lead: await updateLead(body) }, request);
    }
    if (action === "delete") {
      return jsonResponse({ ok: true, deletedId: await deleteLead(body) }, request);
    }
    if (action === "listLeadNotes") {
      return jsonResponse({ ok: true, notes: await listLeadNotes(body.leadId) }, request);
    }
    if (action === "addLeadNote") {
      return jsonResponse({ ok: true, notes: await addLeadNote(body) }, request);
    }
    return jsonResponse({ ok: false, error: "Unknown action: " + action }, request);
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) }, request);
  }
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

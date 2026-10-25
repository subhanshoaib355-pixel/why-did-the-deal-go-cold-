import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getZetarisToken } from "../zetaris-auth.ts";
import { zetarisPost } from "../zetarisAuth.ts";

type Row = Record<string, unknown>;

const DEAL_IDS = ["D001", "D002", "D003", "D004", "D005", "D006", "D007", "D008"];
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");

async function selectAll(select: string): Promise<Row[]> {
  await getZetarisToken();
  const res = await zetarisPost("/query/sql/start", { select, pageLimit: 100 });
  const text = (await res.text()).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { records?: Row[]; totalCount?: number };
  const records = Array.isArray(body.records) ? body.records : [];
  if (typeof body.totalCount === "number" && body.totalCount > records.length) {
    throw new Error(`query returned ${records.length} of ${body.totalCount} rows`);
  }
  return records.map(businessRow);
}

function businessRow(row: Row): Row {
  const out: Row = {};
  for (const key of Object.keys(row)) {
    if (/token|password|secret|authorization/i.test(key)) {
      throw new Error(`refusing secret-like column ${key}`);
    }
    const value = row[key];
    if (typeof value === "string" && /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) {
      throw new Error(`refusing jwt-like value in column ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function text(row: Row, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function byId(key: string): (left: Row, right: Row) => number {
  return (left, right) => text(left, key).localeCompare(text(right, key));
}

function writeRows(name: string, rows: Row[]): void {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  console.log(`${name} ${rows.length}`);
}

const dealIds = new Set(DEAL_IDS);
const deals = (await selectAll("SELECT * FROM dealtrace_crm.deals"))
  .filter((row) => dealIds.has(text(row, "deal_id")))
  .sort(byId("deal_id"));
const contactIds = new Set(deals.map((row) => text(row, "contact_id")));
const companies = new Set(deals.map((row) => text(row, "company_name")));
const contacts = (await selectAll("SELECT * FROM contact.contact"))
  .filter((row) => contactIds.has(text(row, "contact_id")) || companies.has(text(row, "company")))
  .sort(byId("contact_id"));
const addresses = new Set(contacts.map((row) => text(row, "email")).filter((email) => email.length > 0));
const emails = (await selectAll("SELECT * FROM emails.emails"))
  .filter((row) => dealIds.has(text(row, "deal_id")) || addresses.has(text(row, "from")) || addresses.has(text(row, "to")))
  .sort(byId("email_id"));
const notes = (await selectAll("SELECT * FROM call_note.call_note"))
  .filter((row) => dealIds.has(text(row, "deal_id")))
  .sort(byId("note_id"));

fs.mkdirSync(dataDir, { recursive: true });
writeRows("deals.json", deals);
writeRows("contacts.json", contacts);
writeRows("emails.json", emails);
writeRows("call_notes.json", notes);

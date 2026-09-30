import fs from "node:fs";
import pg from "pg";

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = fs.readFileSync(new URL("./init.sql", import.meta.url), "utf8");
const client = new Client({ connectionString: url });
await client.connect();
await client.query(sql);
await client.end();
console.log("PR-Brain database ready");

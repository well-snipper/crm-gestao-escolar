import fs from "node:fs/promises";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { db } from "./db.js";

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  console.error("Defina ADMIN_EMAIL e ADMIN_PASSWORD no arquivo .env antes de inicializar o banco.");
  await db.end();
  process.exit(1);
}

if (adminPassword.length < 8) {
  console.error("ADMIN_PASSWORD deve possuir pelo menos 8 caracteres.");
  await db.end();
  process.exit(1);
}

const sql = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
await db.query(sql);

const hash = await bcrypt.hash(adminPassword, 12);
await db.query(
  `INSERT INTO usuarios (nome,email,senha_hash,perfil)
   VALUES ($1,$2,$3,'administrador')
   ON CONFLICT (email) DO NOTHING`,
  ["Administrador", adminEmail, hash]
);

console.log("Banco preparado. Use as credenciais definidas no .env para o primeiro acesso.");
await db.end();

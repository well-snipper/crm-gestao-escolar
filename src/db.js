import pg from "pg";
import "dotenv/config";
const { Pool } = pg;
export const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false });
db.on("error", error => console.error("Erro inesperado no banco:", error.message));

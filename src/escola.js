import "dotenv/config";

export const ESCOLA = Object.freeze({
  nome: process.env.ESCOLA_NOME || "Instituição de Ensino Demo",
  cnpj: process.env.ESCOLA_CNPJ || "00.000.000/0000-00",
  endereco: process.env.ESCOLA_ENDERECO || "Endereço de demonstração",
  representante: process.env.ESCOLA_REPRESENTANTE || "Representante Demo",
  telefone: process.env.ESCOLA_TELEFONE || "(00) 00000-0000",
  email: process.env.ESCOLA_EMAIL || "contato@exemplo.com"
});

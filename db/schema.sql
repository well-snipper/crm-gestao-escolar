CREATE TABLE IF NOT EXISTS usuarios (id BIGSERIAL PRIMARY KEY,nome VARCHAR(120) NOT NULL,email VARCHAR(180) UNIQUE NOT NULL,senha_hash TEXT NOT NULL,perfil VARCHAR(30) NOT NULL CHECK(perfil IN ('administrador','direcao','secretaria','professor','consulta','financeiro')),ativo BOOLEAN NOT NULL DEFAULT TRUE,criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check CHECK(perfil IN ('administrador','direcao','secretaria','professor','consulta','financeiro'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario VARCHAR(40);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cpf VARCHAR(11);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_usuario_unico ON usuarios(LOWER(usuario)) WHERE usuario IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_cpf_unico ON usuarios(cpf) WHERE cpf IS NOT NULL;
CREATE TABLE IF NOT EXISTS interessados (id BIGSERIAL PRIMARY KEY,responsavel_nome VARCHAR(150) NOT NULL,aluno_nome VARCHAR(150) NOT NULL,telefone VARCHAR(30) NOT NULL,email VARCHAR(180),origem VARCHAR(30) NOT NULL,turma_interesse VARCHAR(60),plano_horas VARCHAR(10),entrada TIME,saida TIME,status VARCHAR(40) NOT NULL DEFAULT 'novo',proximo_contato DATE,observacoes TEXT,criado_por BIGINT REFERENCES usuarios(id),criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_interessados_status ON interessados(status);
CREATE INDEX IF NOT EXISTS idx_interessados_telefone ON interessados(telefone);
CREATE TABLE IF NOT EXISTS matriculas (id BIGSERIAL PRIMARY KEY,interessado_id BIGINT REFERENCES interessados(id),ano_letivo INTEGER NOT NULL,aluno_nome VARCHAR(150) NOT NULL,aluno_nascimento DATE NOT NULL,aluno_cpf VARCHAR(20),turma VARCHAR(60) NOT NULL,responsavel_nome VARCHAR(150) NOT NULL,responsavel_cpf VARCHAR(20) NOT NULL,responsavel_rg VARCHAR(30),responsavel_telefone VARCHAR(30) NOT NULL,responsavel_email VARCHAR(180),responsavel_endereco TEXT NOT NULL,parentesco VARCHAR(40) NOT NULL,plano_horas VARCHAR(10) NOT NULL,entrada TIME NOT NULL,saida TIME NOT NULL,mensalidade NUMERIC(12,2) NOT NULL,vencimento_dia SMALLINT NOT NULL DEFAULT 5,status VARCHAR(30) NOT NULL DEFAULT 'rascunho',criado_por BIGINT REFERENCES usuarios(id),criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS contratos (id BIGSERIAL PRIMARY KEY,matricula_id BIGINT UNIQUE NOT NULL REFERENCES matriculas(id),numero VARCHAR(40) UNIQUE NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'gerado',criado_por BIGINT REFERENCES usuarios(id),criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS historico (id BIGSERIAL PRIMARY KEY,tipo_entidade VARCHAR(30) NOT NULL,entidade_id BIGINT NOT NULL,acao VARCHAR(80) NOT NULL,detalhes TEXT,usuario_id BIGINT REFERENCES usuarios(id),criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS interessado_contatos (
  id BIGSERIAL PRIMARY KEY,
  interessado_id BIGINT NOT NULL REFERENCES interessados(id) ON DELETE CASCADE,
  canal VARCHAR(30) NOT NULL CHECK(canal IN ('whatsapp','telefone','email','presencial','outro')),
  resumo TEXT NOT NULL,
  proximo_contato DATE,
  usuario_id BIGINT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contatos_interessado ON interessado_contatos(interessado_id,criado_em DESC);
CREATE TABLE IF NOT EXISTS matricula_responsaveis (
  id BIGSERIAL PRIMARY KEY,
  matricula_id BIGINT NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
  ordem SMALLINT NOT NULL CHECK(ordem IN (1,2)),
  nome VARCHAR(150) NOT NULL,
  cpf VARCHAR(20) NOT NULL,
  rg VARCHAR(30),
  telefone VARCHAR(30) NOT NULL,
  email VARCHAR(180),
  endereco TEXT NOT NULL,
  parentesco VARCHAR(40) NOT NULL,
  financeiro BOOLEAN NOT NULL DEFAULT FALSE,
  assinante BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(matricula_id,ordem)
);
CREATE INDEX IF NOT EXISTS idx_responsaveis_matricula ON matricula_responsaveis(matricula_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matricula_interessado_ano ON matriculas(interessado_id,ano_letivo) WHERE interessado_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS cobrancas (
  id BIGSERIAL PRIMARY KEY,
  matricula_id BIGINT NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL CHECK(tipo IN ('matricula','mensalidade')),
  parcela_numero SMALLINT NOT NULL CHECK(parcela_numero BETWEEN 0 AND 12),
  competencia DATE,
  vencimento DATE NOT NULL,
  valor_original NUMERIC(12,2) NOT NULL CHECK(valor_original >= 0),
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(desconto >= 0),
  acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(acrescimo >= 0),
  valor_pago NUMERIC(12,2),
  status VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','pago','cancelado')),
  pago_em DATE,
  forma_pagamento VARCHAR(30),
  observacoes TEXT,
  atualizado_por BIGINT REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(matricula_id,tipo,parcela_numero)
);
CREATE INDEX IF NOT EXISTS idx_cobrancas_vencimento ON cobrancas(vencimento,status);
CREATE INDEX IF NOT EXISTS idx_cobrancas_matricula ON cobrancas(matricula_id);
INSERT INTO cobrancas(matricula_id,tipo,parcela_numero,competencia,vencimento,valor_original)
SELECT m.id,'matricula',0,NULL,m.criado_em::date,m.mensalidade FROM matriculas m
ON CONFLICT(matricula_id,tipo,parcela_numero) DO NOTHING;
INSERT INTO cobrancas(matricula_id,tipo,parcela_numero,competencia,vencimento,valor_original)
SELECT m.id,'mensalidade',mes,make_date(m.ano_letivo,mes,1),make_date(m.ano_letivo,mes,LEAST(m.vencimento_dia,28)),m.mensalidade
FROM matriculas m CROSS JOIN generate_series(1,12) mes
ON CONFLICT(matricula_id,tipo,parcela_numero) DO NOTHING;
CREATE OR REPLACE FUNCTION sincronizar_cobrancas_matricula() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO cobrancas(matricula_id,tipo,parcela_numero,competencia,vencimento,valor_original)
  VALUES(NEW.id,'matricula',0,NULL,NEW.criado_em::date,NEW.mensalidade)
  ON CONFLICT(matricula_id,tipo,parcela_numero) DO NOTHING;
  INSERT INTO cobrancas(matricula_id,tipo,parcela_numero,competencia,vencimento,valor_original)
  SELECT NEW.id,'mensalidade',mes,make_date(NEW.ano_letivo,mes,1),make_date(NEW.ano_letivo,mes,LEAST(NEW.vencimento_dia,28)),NEW.mensalidade
  FROM generate_series(1,12) mes
  ON CONFLICT(matricula_id,tipo,parcela_numero) DO NOTHING;
  UPDATE cobrancas SET valor_original=NEW.mensalidade,atualizado_em=NOW()
  WHERE matricula_id=NEW.id AND tipo='matricula' AND status='pendente';
  UPDATE cobrancas SET valor_original=NEW.mensalidade,competencia=make_date(NEW.ano_letivo,parcela_numero,1),vencimento=make_date(NEW.ano_letivo,parcela_numero,LEAST(NEW.vencimento_dia,28)),atualizado_em=NOW()
  WHERE matricula_id=NEW.id AND tipo='mensalidade' AND status='pendente';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sincronizar_cobrancas ON matriculas;
CREATE TRIGGER trg_sincronizar_cobrancas AFTER INSERT OR UPDATE OF ano_letivo,mensalidade,vencimento_dia ON matriculas FOR EACH ROW EXECUTE FUNCTION sincronizar_cobrancas_matricula();

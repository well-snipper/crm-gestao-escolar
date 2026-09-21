# CRM Escolar — Sistema de Gestão para Instituição de Ensino

Projeto full stack desenvolvido para transformar necessidades administrativas reais de uma instituição de ensino em um sistema web centralizado.

> **Status:** em desenvolvimento ativo · versão de portfólio baseada na V27.1

## Sobre o projeto

O CRM foi projetado para funcionar em um computador servidor e ser acessado por outras estações conectadas à mesma rede local. A aplicação centraliza processos de atendimento, matrícula, contratos, financeiro, usuários e auditoria, com diferentes níveis de permissão.

A versão deste repositório foi preparada para portfólio: credenciais e dados institucionais reais não fazem parte do código público.

## Principais funcionalidades

- Autenticação por usuário, CPF ou e-mail.
- Senhas armazenadas com hash usando `bcrypt`.
- Bloqueio temporário após repetidas tentativas incorretas de login.
- Sessões persistidas no PostgreSQL.
- Perfis e permissões: administrador, direção, secretaria, professor, consulta e financeiro.
- Cadastro e acompanhamento de interessados.
- Histórico de contatos e etapas do atendimento.
- Conversão de interessado em matrícula.
- Cadastro de responsáveis e definição de responsável financeiro/assinante.
- Geração e gerenciamento de contratos.
- Controle de cobranças, mensalidades, vencimentos, descontos, acréscimos e pagamentos.
- Relatórios financeiros.
- Importação de interessados.
- Auditoria de operações realizadas no sistema.
- Visualização de sessões ativas pelo administrador.
- Alteração e redefinição segura de senhas.
- Backup manual e automático com processo de restauração controlada.
- Identificação dos endereços para acesso ao CRM dentro da rede local.
- Geração de documentos em PDF com `PDFKit`.

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Backend | Node.js 22 + Express 5 |
| Frontend | HTML5, CSS3 e JavaScript |
| Banco de dados | PostgreSQL |
| Autenticação | Express Session + connect-pg-simple |
| Segurança | bcryptjs + Helmet |
| PDF | PDFKit |
| Desenvolvimento | Nodemon |

## Arquitetura

```text
┌──────────────────────────────┐
│ Navegadores / estações       │
│ da rede local                │
└──────────────┬───────────────┘
               │ HTTP
               ▼
┌──────────────────────────────┐
│ Node.js + Express            │
│ API + regras de negócio      │
│ autenticação + autorização   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ PostgreSQL                   │
│ dados + sessões              │
└──────────────────────────────┘
```

Mais detalhes em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Estrutura do projeto

```text
crm-escolar/
├── db/
│   └── schema.sql
├── docs/
│   ├── ARCHITECTURE.md
│   └── screenshots/
├── public/
│   ├── assets/
│   ├── css/
│   ├── js/
│   └── index.html
├── src/
│   ├── db.js
│   ├── escola.js
│   ├── init-db.js
│   └── server.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Como executar localmente

### Pré-requisitos

- Node.js 22 ou superior.
- PostgreSQL.
- Git.

### 1. Clone o repositório

```bash
git clone URL_DO_SEU_REPOSITORIO
cd crm-escolar
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Crie o banco

No PostgreSQL:

```sql
CREATE DATABASE crm_gestao_escolar;
```

### 4. Configure as variáveis de ambiente

Copie `.env.example` para `.env` e altere os valores antes de executar o sistema.

Exemplo:

```env
DATABASE_URL=postgresql://postgres:SUA_SENHA@localhost:5432/crm_gestao_escolar
SESSION_SECRET=UMA_CHAVE_LONGA_E_ALEATORIA
ADMIN_EMAIL=admin@exemplo.local
ADMIN_PASSWORD=UMA_SENHA_FORTE
```

Nunca publique o arquivo `.env`.

### 5. Inicialize o banco de dados

```bash
npm run db:init
```

### 6. Inicie a aplicação

```bash
npm run dev
```

Acesse:

```text
http://localhost:3000
```

## Uso em rede local

O servidor pode utilizar `HOST=0.0.0.0`, permitindo que computadores autorizados na mesma rede acessem a aplicação pelo IP privado da máquina servidora.

Em ambiente real, regras de firewall e acesso à rede devem ser configuradas de forma apropriada. A porta do sistema não deve ser exposta diretamente à internet.

## Segurança adotada no projeto

- Hash de senhas com bcrypt.
- Sessões persistidas no banco.
- Cookie de sessão `httpOnly` e `sameSite=lax`.
- `secure` habilitado quando executado em produção.
- Controle de autorização no backend por perfil.
- Bloqueio após múltiplas tentativas de login inválidas.
- Consultas SQL parametrizadas em operações da aplicação.
- Variáveis sensíveis mantidas fora do repositório.
- Backups locais excluídos pelo `.gitignore`.

## Screenshots

As imagens da demonstração serão adicionadas em [`docs/screenshots`](docs/screenshots). Todos os registros utilizados nas capturas devem ser fictícios.

## O que este projeto demonstra

Além da implementação técnica, o projeto envolve levantamento de necessidades, modelagem das regras de negócio, desenvolvimento incremental, correção de erros, controle de acesso, segurança, banco de dados e preparação para implantação em uma rede real.

## Próximos passos

- Evoluir a organização interna do backend em módulos de rotas, serviços e repositórios.
- Ampliar testes automatizados.
- Criar ambiente de demonstração com dados fictícios.
- Implementar pipeline de integração contínua.
- Preparar estratégia de implantação com HTTPS para eventual acesso externo.

## Aviso sobre dados

Este repositório deve conter somente dados fictícios. Dados pessoais de alunos, responsáveis, usuários, informações financeiras, backups, credenciais e arquivos `.env` não devem ser versionados.

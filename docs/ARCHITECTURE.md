# Arquitetura

O CRM utiliza uma arquitetura web simples, adequada para execução em um computador servidor dentro de uma rede local.

```text
Navegador (estações)
        |
        | HTTP / rede local
        v
Node.js + Express
        |
        | pg
        v
PostgreSQL
```

## Camadas principais

- **Frontend:** HTML, CSS e JavaScript sem framework.
- **Backend:** Node.js e Express.
- **Banco de dados:** PostgreSQL.
- **Autenticação:** sessão persistida no PostgreSQL e senhas com bcrypt.
- **Autorização:** controle de acesso baseado em perfis.
- **Segurança:** Helmet, cookies `httpOnly`, limitação de tentativas de login e consultas parametrizadas.
- **Documentos:** geração de PDF com PDFKit.
- **Operação:** suporte a execução local e acesso por estações na mesma rede.
- **Continuidade:** backup manual/automático e restauração controlada.

## Perfis de acesso

O sistema contempla perfis como administrador, direção, secretaria, professor, consulta e financeiro. As permissões são verificadas nas rotas do backend.

## Observação

Esta versão pública é destinada a portfólio e demonstração. Dados institucionais e credenciais devem ser configurados por variáveis de ambiente e exemplos públicos devem utilizar apenas dados fictícios.

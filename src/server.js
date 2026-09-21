import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "dotenv/config";
import { db } from "./db.js";
import { ESCOLA } from "./escola.js";

const app=express(), PgStore=connectPgSimple(session);
const versaoSistema="27.1";
const minutosOciosidade=Math.max(1,Number.parseInt(process.env.SESSION_IDLE_MINUTES||"30",10)||30);
const backupAutomaticoAtivo=String(process.env.AUTO_BACKUP_ENABLED||"true").toLowerCase()!=="false";
const horarioInformado=String(process.env.AUTO_BACKUP_TIME||"19:00").trim();
const horarioBackupAutomatico=/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horarioInformado)?horarioInformado:"19:00";
let timerBackupAutomatico=null,backupAutomaticoExecutando=false;
const tentativasLogin=new Map(),maxTentativasLogin=5,bloqueioLoginMs=15*60*1000;
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"25mb"})); app.use(express.urlencoded({extended:true,limit:"25mb"}));
app.use(session({store:new PgStore({pool:db,createTableIfMissing:true}),secret:process.env.SESSION_SECRET||"altere-esta-chave",resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:minutosOciosidade*60*1000}}));
const root=path.dirname(fileURLToPath(import.meta.url));
const pastaBackups=path.join(root,"../backups");
app.use(express.static(path.join(root,"../public")));
const auth=(req,res,next)=>{if(!req.session.user)return res.status(401).json({erro:"Faça login."});const agora=new Date().toISOString();req.session.loginEm=req.session.loginEm||agora;req.session.ultimaPresenca=req.session.ultimaPresenca||agora;next()};
const permitir=(...perfis)=>(req,res,next)=>req.session.user&&perfis.includes(req.session.user.perfil)?next():res.status(403).json({erro:"Seu perfil não possui permissão para esta operação."});
const perfisPermitidos=["administrador","direcao","secretaria","professor","consulta","financeiro"];
const podeAtender=permitir("administrador","direcao","secretaria");
const podeConsultar=permitir("administrador","direcao","secretaria","consulta");
const podeFinanceiro=permitir("administrador","direcao","secretaria","financeiro");
const podeRelatorioFinanceiro=permitir("administrador","direcao","financeiro");
const clean=v=>typeof v==="string"?v.trim():"";
const chaveTentativaLogin=(req,identificador)=>`${req.ip}|${String(identificador||"").toLowerCase()}`;
function tempoBloqueioLogin(chave){const item=tentativasLogin.get(chave);if(!item)return 0;if(item.bloqueadoAte>Date.now())return item.bloqueadoAte-Date.now();if(Date.now()-item.inicio>bloqueioLoginMs)tentativasLogin.delete(chave);return 0}
function registrarFalhaLogin(chave){const agora=Date.now(),anterior=tentativasLogin.get(chave),item=!anterior||agora-anterior.inicio>bloqueioLoginMs?{falhas:0,inicio:agora,bloqueadoAte:0}:anterior;item.falhas++;if(item.falhas>=maxTentativasLogin)item.bloqueadoAte=agora+bloqueioLoginMs;tentativasLogin.set(chave,item);if(tentativasLogin.size>5000)for(const [k,v] of tentativasLogin)if(agora-v.inicio>bloqueioLoginMs&&v.bloqueadoAte<=agora)tentativasLogin.delete(k);return Math.max(0,item.bloqueadoAte-agora)}
const statusPermitidos=["novo","em_contato","visita_agendada","proposta_enviada","aguardando_retorno","matriculado","sem_interesse"];
const canaisPermitidos=["whatsapp","telefone","email","presencial","outro"];
const idValido=id=>/^\d+$/.test(String(id));
const nomeCompleto=v=>clean(v).split(/\s+/).filter(Boolean).length>=2;
const somenteDigitos=v=>String(v||"").replace(/\D/g,"");
const cpfValido=v=>{const cpf=somenteDigitos(v);if(!/^\d{11}$/.test(cpf)||/^(\d)\1{10}$/.test(cpf))return false;for(let tamanho=9;tamanho<=10;tamanho++){let soma=0;for(let i=0;i<tamanho;i++)soma+=Number(cpf[i])*(tamanho+1-i);const digito=(soma*10)%11%10;if(digito!==Number(cpf[tamanho]))return false}return true};
const usuarioValido=v=>/^[a-zA-Z][a-zA-Z0-9._-]{2,39}$/.test(clean(v));
const moeda=v=>Number(v).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
const dataExtenso=ano=>`São Paulo, ______ de __________________________ de ${ano}.`;
const logoPath=path.join(root,"../public/assets/logo-colegio-horizonte.png");
const turmasPermitidas=["Berçário I","Berçário II","Mini Maternal","Maternal","Pré-1","Pré-2","Fundamental 1 - definir ano","1º Ano","2º Ano","3º Ano","4º Ano","5º Ano"];
const minutos=v=>{const [h,m]=String(v||"").split(":").map(Number);return Number.isFinite(h)&&Number.isFinite(m)?h*60+m:NaN};
const validarDuracao=b=>{const limite=parseInt(String(b.plano_horas||""),10)*60,inicio=minutos(b.entrada),fim=minutos(b.saida);if(!Number.isFinite(limite)||!Number.isFinite(inicio)||!Number.isFinite(fim)||fim<=inicio)return "Informe um plano e horários válidos.";const total=fim-inicio;if(total>limite+15){const horas=Math.floor(total/60),mins=total%60;return `O plano de ${b.plano_horas} permite permanência de até ${parseInt(b.plano_horas,10)} horas. O horário informado totaliza ${horas}h${mins?String(mins).padStart(2,"0"):""}.`}return null};
const fundamental1=turma=>/fundamental|[1-5]\s*[ºo°]?\s*ano/i.test(String(turma||""));
function parametrosRelatorioFinanceiro(req){const ano=Number.parseInt(req.query.ano,10)||new Date().getFullYear(),busca=clean(req.query.q),status=clean(req.query.status),filtros=["m.ano_letivo=$1"],valores=[ano];if(busca){valores.push(`%${busca}%`);filtros.push(`(m.aluno_nome ILIKE $${valores.length} OR m.responsavel_nome ILIKE $${valores.length})`)}if(status==="atrasado")filtros.push("c.status='pendente' AND c.vencimento<CURRENT_DATE");else if(status==="pendente")filtros.push("c.status='pendente' AND c.vencimento>=CURRENT_DATE");else if(["pago","cancelado"].includes(status)){valores.push(status);filtros.push(`c.status=$${valores.length}`)}return{ano,valores,where:filtros.join(" AND ")}}
async function consultarRelatorioFinanceiro(req){const p=parametrosRelatorioFinanceiro(req),{rows}=await db.query(`SELECT c.*,m.aluno_nome,m.responsavel_nome,m.ano_letivo,(c.valor_original-c.desconto+c.acrescimo)::numeric(12,2) valor_atual,CASE WHEN c.status='pendente' AND c.vencimento<CURRENT_DATE THEN 'atrasado' ELSE c.status END status_exibicao FROM cobrancas c JOIN matriculas m ON m.id=c.matricula_id WHERE ${p.where} ORDER BY c.vencimento,m.aluno_nome`,p.valores);return{...p,rows}}
function dataIsoSegura(v){
  if(!v)return "";
  if(v instanceof Date){
    if(Number.isNaN(v.getTime()))return "";
    return [v.getUTCFullYear(),String(v.getUTCMonth()+1).padStart(2,"0"),String(v.getUTCDate()).padStart(2,"0")].join("-");
  }
  const texto=String(v).trim(),iso=texto.match(/^(\d{4})-(\d{2})-(\d{2})/),br=texto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const partes=iso?[iso[1],iso[2],iso[3]]:br?[br[3],br[2],br[1]]:null;
  if(partes){
    const ano=Number(partes[0]),mes=Number(partes[1]),dia=Number(partes[2]),data=new Date(Date.UTC(ano,mes-1,dia));
    if(data.getUTCFullYear()===ano&&data.getUTCMonth()===mes-1&&data.getUTCDate()===dia)return [String(ano).padStart(4,"0"),String(mes).padStart(2,"0"),String(dia).padStart(2,"0")].join("-");
  }
  const data=new Date(texto);
  return Number.isNaN(data.getTime())?"":[data.getUTCFullYear(),String(data.getUTCMonth()+1).padStart(2,"0"),String(data.getUTCDate()).padStart(2,"0")].join("-");
}
const dataRelatorio=v=>{const iso=dataIsoSegura(v);return iso?[iso.slice(8,10),iso.slice(5,7),iso.slice(0,4)].join("/"):""};
const csvCampo=v=>{let s=String(v??"");if(/^[=+\-@]/.test(s))s=`'${s}`;return `"${s.replace(/"/g,'""')}"`};

function adicionarIdentidade(doc,numero,paginaNumero){
  const pagina=doc.page;
  const yAtual=doc.y;
  doc.save().opacity(.055).image(logoPath,pagina.width/2-185,pagina.height/2-185,{fit:[370,370],align:"center",valign:"center"}).restore();
  doc.save().opacity(1).image(logoPath,55,82,{fit:[34,34]});
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#4b2482").text(ESCOLA.nome,100,85,{width:355,lineBreak:false});
  doc.font("Helvetica").fontSize(7).fillColor("#333333").text(`${ESCOLA.cnpj} | ${ESCOLA.telefone} | ${ESCOLA.email}`,100,99,{width:425,lineBreak:false});
  doc.moveTo(55,116).lineTo(pagina.width-55,116).lineWidth(.6).strokeColor("#6c3aa5").stroke();
  doc.restore();
  doc.font("Helvetica").fontSize(7).fillColor("#666666").text(`Contrato ${numero}`,55,pagina.height-64,{width:250,lineBreak:false});
  doc.text(`Página ${paginaNumero}`,pagina.width-150,pagina.height-64,{width:95,align:"right",lineBreak:false});
  doc.fillColor("#000000");
  doc.x=pagina.margins.left;
  doc.y=yAtual;
}

function tituloSecao(doc,titulo){
  if(doc.y>doc.page.height-120)doc.addPage();
  doc.moveDown(.35).font("Helvetica-Bold").fontSize(10).fillColor("#4b2482").text(titulo,{keepTogether:true});
  doc.fillColor("#111111").moveDown(.3);
}

function paragrafo(doc,texto){
  doc.font("Helvetica").fontSize(9).fillColor("#111111").text(texto,{align:"justify",lineGap:2});
  doc.moveDown(.5);
}

function linhaDado(doc,rotulo,valor){
  doc.font("Helvetica").fontSize(9).fillColor("#111111").text(`${rotulo}:`,{continued:true});
  doc.font("Helvetica-Bold").text(`\u00A0${String(valor||"Não informado")}`);
}

app.post("/api/login",async(req,res)=>{const identificador=clean(req.body.acesso||req.body.email),cpf=somenteDigitos(identificador),senha=req.body.senha,chave=chaveTentativaLogin(req,identificador),restante=tempoBloqueioLogin(chave);if(restante>0)return res.status(429).json({erro:`Muitas tentativas incorretas. Aguarde ${Math.ceil(restante/60000)} minuto(s) e tente novamente.`});const {rows}=await db.query("SELECT * FROM usuarios WHERE ativo=TRUE AND (LOWER(email)=LOWER($1) OR LOWER(usuario)=LOWER($1) OR cpf=$2) LIMIT 1",[identificador,cpf]);if(!rows[0]||!await bcrypt.compare(String(senha||""),rows[0].senha_hash)){const espera=registrarFalhaLogin(chave);return res.status(espera?429:401).json({erro:espera?"Muitas tentativas incorretas. O acesso foi bloqueado por 15 minutos.":"Acesso ou senha inválidos."})}tentativasLogin.delete(chave);const agora=new Date().toISOString();req.session.user={id:rows[0].id,nome:rows[0].nome,email:rows[0].email,usuario:rows[0].usuario,perfil:rows[0].perfil};req.session.loginEm=agora;req.session.ultimaPresenca=agora;req.session.acesso={ip:String(req.ip||"").replace("::ffff:",""),agente:clean(req.get("user-agent"))};res.json({usuario:req.session.user});});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/sessao",auth,(req,res)=>res.json({ok:true,ociosidade_minutos:minutosOciosidade}));
app.post("/api/presenca",auth,(req,res)=>{req.session.ultimaPresenca=new Date().toISOString();res.json({ok:true})});
app.post("/api/minha-conta/senha",auth,async(req,res)=>{const senhaAtual=String(req.body.senha_atual||""),senha=String(req.body.senha||""),confirmacao=String(req.body.confirmar_senha||"");if(!senhaAtual)return res.status(400).json({erro:"Informe sua senha atual."});if(senha.length<8)return res.status(400).json({erro:"A nova senha deve ter pelo menos 8 caracteres."});if(senha!==confirmacao)return res.status(400).json({erro:"A nova senha e a confirmação não são iguais."});const usuario=await db.query("SELECT id,senha_hash FROM usuarios WHERE id=$1 AND ativo=TRUE",[req.session.user.id]);if(!usuario.rows[0]||!await bcrypt.compare(senhaAtual,usuario.rows[0].senha_hash))return res.status(400).json({erro:"A senha atual está incorreta."});if(await bcrypt.compare(senha,usuario.rows[0].senha_hash))return res.status(400).json({erro:"A nova senha deve ser diferente da senha atual."});const client=await db.connect();try{await client.query("BEGIN");await client.query("UPDATE usuarios SET senha_hash=$1 WHERE id=$2",[await bcrypt.hash(senha,12),req.session.user.id]);await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('usuario',$1,'senha_alterada','O usuário alterou a própria senha.',$1)",[req.session.user.id]);await client.query(`DELETE FROM "session" WHERE sid<>$1 AND sess->'user'->>'id'=$2`,[req.sessionID,String(req.session.user.id)]);await client.query("COMMIT");res.json({ok:true,sessoes_encerradas:true})}catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}});
function descreverDispositivo(agente=""){const navegador=/Edg\//.test(agente)?"Edge":/OPR\//.test(agente)?"Opera":/Chrome\//.test(agente)?"Chrome":/Firefox\//.test(agente)?"Firefox":/Safari\//.test(agente)?"Safari":"Navegador";const sistema=/Windows/i.test(agente)?"Windows":/Android/i.test(agente)?"Android":/(iPhone|iPad)/i.test(agente)?"iPhone/iPad":/Mac OS/i.test(agente)?"Mac":/Linux/i.test(agente)?"Linux":"Dispositivo";return `${sistema} · ${navegador}`}
app.get("/api/sistema/sessoes",auth,permitir("administrador"),async(req,res)=>{const {rows}=await db.query('SELECT sid,sess,expire FROM "session" WHERE expire>NOW() ORDER BY expire DESC'),agora=Date.now(),sessoes=[];for(const row of rows){let s=row.sess;try{if(typeof s==="string")s=JSON.parse(s)}catch{continue}if(!s?.user)continue;const expiraEm=new Date(row.expire).getTime(),loginEm=new Date(s.loginEm||agora).getTime(),ultimaPresenca=new Date(s.ultimaPresenca||s.loginEm||agora).getTime(),ocioso=Math.max(0,Math.floor((agora-ultimaPresenca)/1000));sessoes.push({usuario:{id:s.user.id,nome:s.user.nome,email:s.user.email,usuario:s.user.usuario,perfil:s.user.perfil},login_em:new Date(loginEm).toISOString(),ultima_presenca:new Date(ultimaPresenca).toISOString(),expira_em:new Date(expiraEm).toISOString(),duracao_segundos:Math.max(0,Math.floor((agora-loginEm)/1000)),ocioso_segundos:ocioso,restante_segundos:Math.max(0,Math.floor((expiraEm-agora)/1000)),status:ocioso<=45?"online":"ocioso",dispositivo:descreverDispositivo(s.acesso?.agente),ip:s.acesso?.ip||"Não identificado",sessao_atual:row.sid===req.sessionID})}sessoes.sort((a,b)=>(a.status===b.status?new Date(b.ultima_presenca)-new Date(a.ultima_presenca):a.status==="online"?-1:1));res.json({atualizado_em:new Date().toISOString(),limite_ociosidade_minutos:minutosOciosidade,total:sessoes.length,online:sessoes.filter(x=>x.status==="online").length,sessoes})});
function enderecosIPv4Rede(){try{const enderecos=[];for(const interfaces of Object.values(os.networkInterfaces()))for(const item of interfaces||[]){const ipv4=item.family==="IPv4"||item.family===4;if(ipv4&&!item.internal&&!String(item.address).startsWith("169.254."))enderecos.push(item.address)}return[...new Set(enderecos)]}catch(e){console.warn("Não foi possível identificar automaticamente os endereços da rede:",e.message);return[]}}
app.get("/api/sistema/rede",auth,permitir("administrador"),(req,res)=>{const porta=Number(process.env.PORT)||3000,ips=enderecosIPv4Rede();res.json({versao:versaoSistema,computador:os.hostname(),porta,endereco_local:`http://localhost:${porta}`,enderecos_rede:ips.map(ip=>`http://${ip}:${porta}`),host:process.env.HOST||"0.0.0.0",protecao_login:{max_tentativas:maxTentativasLogin,bloqueio_minutos:bloqueioLoginMs/60000},solicitacao:{ip:req.ip}})});
app.get("/api/auditoria",auth,permitir("administrador"),async(req,res)=>{
  const pagina=Math.max(1,Number.parseInt(req.query.pagina,10)||1),porPagina=50,q=clean(req.query.q),tipo=clean(req.query.tipo),usuarioId=clean(req.query.usuario_id),dataInicio=clean(req.query.data_inicio),dataFim=clean(req.query.data_fim),filtros=[],valores=[];
  if(q){valores.push(`%${q}%`);filtros.push(`(COALESCE(h.detalhes,'') ILIKE $${valores.length} OR COALESCE(u.nome,'Sistema') ILIKE $${valores.length} OR h.acao ILIKE $${valores.length})`)}
  if(["interessado","matricula","cobranca","usuario","exclusao"].includes(tipo)){valores.push(tipo);filtros.push(`h.tipo_entidade=$${valores.length}`)}
  if(/^\d+$/.test(usuarioId)){valores.push(usuarioId);filtros.push(`h.usuario_id=$${valores.length}`)}
  if(/^\d{4}-\d{2}-\d{2}$/.test(dataInicio)){valores.push(dataInicio);filtros.push(`h.criado_em >= $${valores.length}::date`)}
  if(/^\d{4}-\d{2}-\d{2}$/.test(dataFim)){valores.push(dataFim);filtros.push(`h.criado_em < ($${valores.length}::date + INTERVAL '1 day')`)}
  const where=filtros.length?`WHERE ${filtros.join(" AND ")}`:"";
  const totalResultado=await db.query(`SELECT COUNT(*)::int total FROM historico h LEFT JOIN usuarios u ON u.id=h.usuario_id ${where}`,valores);
  const consultaValores=[...valores,porPagina,(pagina-1)*porPagina],limitePos=valores.length+1,offsetPos=valores.length+2;
  const [registros,usuarios]=await Promise.all([
    db.query(`SELECT h.id,h.tipo_entidade,h.entidade_id,h.acao,h.detalhes,h.criado_em,COALESCE(u.nome,'Sistema') usuario_nome,u.perfil usuario_perfil,CASE WHEN h.tipo_entidade='interessado' THEN COALESCE(i.aluno_nome,'Interessado #'||h.entidade_id) WHEN h.tipo_entidade='matricula' THEN COALESCE(m.aluno_nome,'Matrícula #'||h.entidade_id) WHEN h.tipo_entidade='cobranca' THEN COALESCE(cm.aluno_nome,'Cobrança #'||h.entidade_id) WHEN h.tipo_entidade='usuario' THEN COALESCE(ua.nome,'Usuário #'||h.entidade_id) WHEN h.tipo_entidade='exclusao' THEN 'Cadastro excluído #'||h.entidade_id ELSE INITCAP(h.tipo_entidade)||' #'||h.entidade_id END entidade_nome FROM historico h LEFT JOIN usuarios u ON u.id=h.usuario_id LEFT JOIN interessados i ON h.tipo_entidade='interessado' AND i.id=h.entidade_id LEFT JOIN matriculas m ON h.tipo_entidade='matricula' AND m.id=h.entidade_id LEFT JOIN cobrancas c ON h.tipo_entidade='cobranca' AND c.id=h.entidade_id LEFT JOIN matriculas cm ON cm.id=c.matricula_id LEFT JOIN usuarios ua ON h.tipo_entidade='usuario' AND ua.id=h.entidade_id ${where} ORDER BY h.criado_em DESC,h.id DESC LIMIT $${limitePos} OFFSET $${offsetPos}`,consultaValores),
    db.query("SELECT id,nome FROM usuarios ORDER BY nome")
  ]);
  const total=totalResultado.rows[0].total,totalPaginas=Math.max(1,Math.ceil(total/porPagina));
  res.json({registros:registros.rows,usuarios:usuarios.rows,paginacao:{pagina,total,total_paginas:totalPaginas,por_pagina:porPagina}});
});
app.get("/api/painel",auth,async(req,res)=>{const professor=req.session.user.perfil==="professor",financeiro=req.session.user.perfil==="financeiro",restrito=professor||financeiro;const [i,m,c,recentes]=await Promise.all([restrito?Promise.resolve({rows:[{total:0}]}):db.query("SELECT COUNT(*)::int total FROM interessados"),financeiro?Promise.resolve({rows:[{total:0}]}):db.query("SELECT COUNT(*)::int total FROM matriculas"),restrito?Promise.resolve({rows:[{total:0}]}):db.query("SELECT COUNT(*)::int total FROM contratos"),restrito?Promise.resolve({rows:[]}):db.query("SELECT * FROM interessados ORDER BY criado_em DESC LIMIT 8")]);res.json({usuario:req.session.user,sessao:{ociosidade_minutos:minutosOciosidade},indicadores:{interessados:i.rows[0].total,matriculas:m.rows[0].total,contratos:c.rows[0].total},recentes:recentes.rows});});
app.get("/api/interessados",auth,podeConsultar,async(req,res)=>{const busca=clean(req.query.q),status=clean(req.query.status);const filtros=[],valores=[];if(busca){valores.push(`%${busca}%`);filtros.push(`(aluno_nome ILIKE $${valores.length} OR responsavel_nome ILIKE $${valores.length} OR telefone ILIKE $${valores.length})`)}if(status){valores.push(status);filtros.push(`status=$${valores.length}`)}const sql=`SELECT * FROM interessados ${filtros.length?`WHERE ${filtros.join(" AND ")}`:""} ORDER BY atualizado_em DESC LIMIT 300`;const {rows}=await db.query(sql,valores);res.json(rows);});
app.post("/api/interessados",auth,podeAtender,async(req,res)=>{const b=req.body;if(!clean(b.responsavel_nome)||!clean(b.aluno_nome)||!clean(b.telefone))return res.status(400).json({erro:"Preencha responsável, aluno e telefone."});const {rows}=await db.query(`INSERT INTO interessados(responsavel_nome,aluno_nome,telefone,email,origem,turma_interesse,plano_horas,entrada,saida,proximo_contato,observacoes,criado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[clean(b.responsavel_nome),clean(b.aluno_nome),clean(b.telefone),clean(b.email)||null,clean(b.origem)||"whatsapp",clean(b.turma_interesse)||null,clean(b.plano_horas)||null,b.entrada||null,b.saida||null,b.proximo_contato||null,clean(b.observacoes)||null,req.session.user.id]);await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('interessado',$1,'cadastro_criado',$2,$3)",[rows[0].id,`Aluno: ${rows[0].aluno_nome} | Responsável: ${rows[0].responsavel_nome}`,req.session.user.id]);res.status(201).json(rows[0]);});
app.get("/api/interessados/:id",auth,podeConsultar,async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Cadastro inválido."});const [cadastro,contatos]=await Promise.all([db.query("SELECT * FROM interessados WHERE id=$1",[req.params.id]),db.query(`SELECT c.*,u.nome usuario_nome FROM interessado_contatos c LEFT JOIN usuarios u ON u.id=c.usuario_id WHERE c.interessado_id=$1 ORDER BY c.criado_em DESC`,[req.params.id])]);if(!cadastro.rows[0])return res.status(404).json({erro:"Interessado não encontrado."});res.json({interessado:cadastro.rows[0],contatos:contatos.rows});});
app.put("/api/interessados/:id",auth,podeAtender,async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Cadastro inválido."});const b=req.body,status=clean(b.status)||"novo";if(!clean(b.responsavel_nome)||!clean(b.aluno_nome)||!clean(b.telefone))return res.status(400).json({erro:"Preencha responsável, aluno e telefone."});if(!statusPermitidos.includes(status))return res.status(400).json({erro:"Etapa inválida."});const {rows}=await db.query(`UPDATE interessados SET responsavel_nome=$1,aluno_nome=$2,telefone=$3,email=$4,origem=$5,turma_interesse=$6,plano_horas=$7,entrada=$8,saida=$9,status=$10,proximo_contato=$11,observacoes=$12,atualizado_em=NOW() WHERE id=$13 RETURNING *`,[clean(b.responsavel_nome),clean(b.aluno_nome),clean(b.telefone),clean(b.email)||null,clean(b.origem)||"whatsapp",clean(b.turma_interesse)||null,clean(b.plano_horas)||null,b.entrada||null,b.saida||null,status,b.proximo_contato||null,clean(b.observacoes)||null,req.params.id]);if(!rows[0])return res.status(404).json({erro:"Interessado não encontrado."});await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('interessado',$1,'cadastro_atualizado',$2,$3)",[req.params.id,`Etapa: ${status}`,req.session.user.id]);res.json(rows[0]);});
app.delete("/api/interessados/:id",auth,permitir("administrador"),async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Cadastro inválido."});const cadastro=await db.query("SELECT id,aluno_nome FROM interessados WHERE id=$1",[req.params.id]);if(!cadastro.rows[0])return res.status(404).json({erro:"Interessado não encontrado."});const vinculo=await db.query("SELECT id FROM matriculas WHERE interessado_id=$1 LIMIT 1",[req.params.id]);if(vinculo.rows[0])return res.status(409).json({erro:"Este interessado possui uma matrícula vinculada. Exclua primeiro a matrícula do aluno."});let backup;try{backup=await salvarBackupAutomatico(req.session.user,"backup-antes-exclusao")}catch(e){return res.status(e.status||500).json({erro:"A exclusão foi cancelada porque não foi possível criar o backup de segurança."})}const client=await db.connect();try{await client.query("BEGIN");await client.query("DELETE FROM historico WHERE tipo_entidade='interessado' AND entidade_id=$1",[req.params.id]);const removido=await client.query("DELETE FROM interessados WHERE id=$1 RETURNING id",[req.params.id]);if(!removido.rows[0])throw new Error("Cadastro não encontrado.");await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('exclusao',$1,'interessado_excluido',$2,$3)",[req.params.id,`Interessado excluído: ${cadastro.rows[0].aluno_nome} | Backup: ${backup.caminho}`,req.session.user.id]);await client.query("COMMIT");res.json({ok:true,arquivo_backup:backup.caminho})}catch(e){await client.query("ROLLBACK").catch(()=>{});res.status(409).json({erro:"Não foi possível excluir o interessado. Verifique se ainda existe uma matrícula vinculada.",arquivo_backup:backup.caminho})}finally{client.release()}});
app.post("/api/interessados/:id/contatos",auth,podeAtender,async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Cadastro inválido."});const b=req.body,canal=clean(b.canal),resumo=clean(b.resumo);if(!canaisPermitidos.includes(canal)||!resumo)return res.status(400).json({erro:"Informe o canal e o resumo do contato."});const existe=await db.query("SELECT id FROM interessados WHERE id=$1",[req.params.id]);if(!existe.rows[0])return res.status(404).json({erro:"Interessado não encontrado."});const {rows}=await db.query(`INSERT INTO interessado_contatos(interessado_id,canal,resumo,proximo_contato,usuario_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.params.id,canal,resumo,b.proximo_contato||null,req.session.user.id]);await db.query("UPDATE interessados SET proximo_contato=COALESCE($1,proximo_contato),status=CASE WHEN status='novo' THEN 'em_contato' ELSE status END,atualizado_em=NOW() WHERE id=$2",[b.proximo_contato||null,req.params.id]);await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('interessado',$1,'contato_registrado',$2,$3)",[req.params.id,`Canal: ${canal} | ${resumo.slice(0,300)}`,req.session.user.id]);res.status(201).json(rows[0]);});
app.use("/api/matriculas",(req,res,next)=>{if(req.method!=="POST"&&req.method!=="PUT")return next();if(!req.session.user)return res.status(401).json({erro:"Faça login."});if(!["administrador","direcao","secretaria"].includes(req.session.user.perfil))return res.status(403).json({erro:"Seu perfil não possui permissão para esta operação."});const turma=clean(req.body.turma);if(turma&&!turmasPermitidas.includes(turma))return res.status(400).json({erro:"Selecione uma turma válida na lista."});const erroDuracao=validarDuracao(req.body);if(erroDuracao)return res.status(400).json({erro:erroDuracao});next()});
app.get("/api/matriculas",auth,permitir("administrador","direcao","secretaria","professor","consulta"),async(req,res)=>{const professor=req.session.user.perfil==="professor";const campos=professor?"m.id,m.aluno_nome,m.turma,m.ano_letivo,m.status,m.criado_em":"m.id,m.aluno_nome,m.turma,m.ano_letivo,m.responsavel_nome,m.plano_horas,m.status,m.criado_em,c.id contrato_id,c.numero,c.status contrato_status";const {rows}=await db.query(`SELECT ${campos} FROM matriculas m LEFT JOIN contratos c ON c.matricula_id=m.id ORDER BY m.criado_em DESC LIMIT 300`);res.json(rows);});
app.delete("/api/matriculas/:id",auth,permitir("administrador"),async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Matrícula inválida."});const cadastro=await db.query("SELECT id,aluno_nome,interessado_id FROM matriculas WHERE id=$1",[req.params.id]);if(!cadastro.rows[0])return res.status(404).json({erro:"Matrícula não encontrada."});let backup;try{backup=await salvarBackupAutomatico(req.session.user,"backup-antes-exclusao")}catch(e){return res.status(e.status||500).json({erro:"A exclusão foi cancelada porque não foi possível criar o backup de segurança."})}const client=await db.connect();try{await client.query("BEGIN");const atual=await client.query("SELECT interessado_id FROM matriculas WHERE id=$1 FOR UPDATE",[req.params.id]);if(!atual.rows[0])throw new Error("Matrícula não encontrada.");await client.query("DELETE FROM contratos WHERE matricula_id=$1",[req.params.id]);await client.query("DELETE FROM historico WHERE tipo_entidade='matricula' AND entidade_id=$1",[req.params.id]);await client.query("DELETE FROM matriculas WHERE id=$1",[req.params.id]);if(atual.rows[0].interessado_id)await client.query("UPDATE interessados SET status='em_contato',atualizado_em=NOW() WHERE id=$1",[atual.rows[0].interessado_id]);await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('exclusao',$1,'matricula_excluida',$2,$3)",[req.params.id,`Matrícula excluída: ${cadastro.rows[0].aluno_nome} | Backup: ${backup.caminho}`,req.session.user.id]);await client.query("COMMIT");res.json({ok:true,arquivo_backup:backup.caminho})}catch(e){await client.query("ROLLBACK").catch(()=>{});res.status(409).json({erro:"Não foi possível excluir a matrícula. Nenhum dado foi removido.",arquivo_backup:backup.caminho})}finally{client.release()}});
app.get("/api/matriculas/:id",auth,podeAtender,async(req,res)=>{
  if(!idValido(req.params.id))return res.status(400).json({erro:"Matrícula inválida."});
  const [matricula,responsaveis,contrato]=await Promise.all([
    db.query("SELECT * FROM matriculas WHERE id=$1",[req.params.id]),
    db.query("SELECT * FROM matricula_responsaveis WHERE matricula_id=$1 ORDER BY ordem",[req.params.id]),
    db.query("SELECT id,numero,status FROM contratos WHERE matricula_id=$1",[req.params.id])
  ]);
  if(!matricula.rows[0])return res.status(404).json({erro:"Matrícula não encontrada."});
  res.json({matricula:matricula.rows[0],responsaveis:responsaveis.rows,contrato:contrato.rows[0]||null});
});
app.post("/api/matriculas",auth,async(req,res)=>{const b=req.body;const obrigatorios=["ano_letivo","aluno_nome","aluno_nascimento","turma","responsavel_nome","responsavel_cpf","responsavel_telefone","responsavel_endereco","parentesco","plano_horas","entrada","saida","mensalidade"];if(obrigatorios.some(c=>!clean(String(b[c]??""))))return res.status(400).json({erro:"Preencha todos os campos obrigatórios da matrícula."});const financeiro=String(b.responsavel_financeiro||"1"),assinante=String(b.responsavel_assinante||"1"),temSegundo=!!clean(b.responsavel2_nome);if(!nomeCompleto(b.responsavel_nome))return res.status(400).json({erro:"Informe o nome completo do responsável 1."});if((financeiro==="2"||assinante==="2")&&!temSegundo)return res.status(400).json({erro:"Cadastre o segundo responsável antes de selecioná-lo."});if(temSegundo&&!nomeCompleto(b.responsavel2_nome))return res.status(400).json({erro:"Informe o nome completo do responsável 2."});if(temSegundo&&(!clean(b.responsavel2_cpf)||!clean(b.responsavel2_telefone)||!clean(b.responsavel2_parentesco)))return res.status(400).json({erro:"Preencha CPF, telefone e parentesco do segundo responsável."});const client=await db.connect();try{await client.query("BEGIN");const {rows}=await client.query(`INSERT INTO matriculas(interessado_id,ano_letivo,aluno_nome,aluno_nascimento,aluno_cpf,turma,responsavel_nome,responsavel_cpf,responsavel_rg,responsavel_telefone,responsavel_email,responsavel_endereco,parentesco,plano_horas,entrada,saida,mensalidade,vencimento_dia,status,criado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'contrato_gerado',$19) RETURNING *`,[b.interessado_id||null,b.ano_letivo,clean(b.aluno_nome),b.aluno_nascimento,clean(b.aluno_cpf)||null,clean(b.turma),clean(b.responsavel_nome),clean(b.responsavel_cpf),clean(b.responsavel_rg)||null,clean(b.responsavel_telefone),clean(b.responsavel_email)||null,clean(b.responsavel_endereco),clean(b.parentesco),clean(b.plano_horas),b.entrada,b.saida,b.mensalidade,b.vencimento_dia||5,req.session.user.id]);const matricula=rows[0];await client.query(`INSERT INTO matricula_responsaveis(matricula_id,ordem,nome,cpf,rg,telefone,email,endereco,parentesco,financeiro,assinante) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[matricula.id,clean(b.responsavel_nome),clean(b.responsavel_cpf),clean(b.responsavel_rg)||null,clean(b.responsavel_telefone),clean(b.responsavel_email)||null,clean(b.responsavel_endereco),clean(b.parentesco),financeiro==="1",assinante==="1"]);if(temSegundo)await client.query(`INSERT INTO matricula_responsaveis(matricula_id,ordem,nome,cpf,rg,telefone,email,endereco,parentesco,financeiro,assinante) VALUES($1,2,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[matricula.id,clean(b.responsavel2_nome),clean(b.responsavel2_cpf),clean(b.responsavel2_rg)||null,clean(b.responsavel2_telefone),clean(b.responsavel2_email)||null,clean(b.responsavel2_endereco)||clean(b.responsavel_endereco),clean(b.responsavel2_parentesco),financeiro==="2",assinante==="2"]);const numero=`${b.ano_letivo}-${String(matricula.id).padStart(5,"0")}`;const contrato=await client.query("INSERT INTO contratos(matricula_id,numero,criado_por) VALUES($1,$2,$3) RETURNING *",[matricula.id,numero,req.session.user.id]);if(b.interessado_id)await client.query("UPDATE interessados SET status='matriculado',atualizado_em=NOW() WHERE id=$1",[b.interessado_id]);await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('matricula',$1,'matricula_criada',$2,$3)",[matricula.id,`Aluno: ${matricula.aluno_nome} | Contrato: ${numero} | Ano: ${matricula.ano_letivo}`,req.session.user.id]);await client.query("COMMIT");res.status(201).json({matricula,contrato:contrato.rows[0]});}catch(e){await client.query("ROLLBACK");const duplicado=e.code==="23505";res.status(400).json({erro:duplicado?"Já existe uma matrícula deste interessado para esse ano letivo.":"Não foi possível concluir a matrícula."});}finally{client.release();}});
app.put("/api/matriculas/:id",auth,podeAtender,async(req,res)=>{
  if(!idValido(req.params.id))return res.status(400).json({erro:"Matrícula inválida."});
  const b=req.body;
  const obrigatorios=["ano_letivo","aluno_nome","aluno_nascimento","turma","responsavel_nome","responsavel_cpf","responsavel_telefone","responsavel_endereco","parentesco","plano_horas","entrada","saida","mensalidade"];
  if(obrigatorios.some(c=>!clean(String(b[c]??""))))return res.status(400).json({erro:"Preencha todos os campos obrigatórios da matrícula."});
  const financeiro=String(b.responsavel_financeiro||"1"),assinante=String(b.responsavel_assinante||"1"),temSegundo=!!clean(b.responsavel2_nome);
  if(!nomeCompleto(b.responsavel_nome))return res.status(400).json({erro:"Informe o nome completo do responsável 1."});
  if((financeiro==="2"||assinante==="2")&&!temSegundo)return res.status(400).json({erro:"Cadastre o segundo responsável antes de selecioná-lo."});
  if(temSegundo&&!nomeCompleto(b.responsavel2_nome))return res.status(400).json({erro:"Informe o nome completo do responsável 2."});
  if(temSegundo&&(!clean(b.responsavel2_cpf)||!clean(b.responsavel2_telefone)||!clean(b.responsavel2_parentesco)))return res.status(400).json({erro:"Preencha CPF, telefone e parentesco do segundo responsável."});
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const atual=await client.query("SELECT * FROM matriculas WHERE id=$1 FOR UPDATE",[req.params.id]);
    if(!atual.rows[0]){await client.query("ROLLBACK");return res.status(404).json({erro:"Matrícula não encontrada."})}
    const {rows}=await client.query(`UPDATE matriculas SET ano_letivo=$1,aluno_nome=$2,aluno_nascimento=$3,aluno_cpf=$4,turma=$5,responsavel_nome=$6,responsavel_cpf=$7,responsavel_rg=$8,responsavel_telefone=$9,responsavel_email=$10,responsavel_endereco=$11,parentesco=$12,plano_horas=$13,entrada=$14,saida=$15,mensalidade=$16,vencimento_dia=$17 WHERE id=$18 RETURNING *`,[b.ano_letivo,clean(b.aluno_nome),b.aluno_nascimento,clean(b.aluno_cpf)||null,clean(b.turma),clean(b.responsavel_nome),clean(b.responsavel_cpf),clean(b.responsavel_rg)||null,clean(b.responsavel_telefone),clean(b.responsavel_email)||null,clean(b.responsavel_endereco),clean(b.parentesco),clean(b.plano_horas),b.entrada,b.saida,b.mensalidade,b.vencimento_dia||5,req.params.id]);
    await client.query(`INSERT INTO matricula_responsaveis(matricula_id,ordem,nome,cpf,rg,telefone,email,endereco,parentesco,financeiro,assinante) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(matricula_id,ordem) DO UPDATE SET nome=EXCLUDED.nome,cpf=EXCLUDED.cpf,rg=EXCLUDED.rg,telefone=EXCLUDED.telefone,email=EXCLUDED.email,endereco=EXCLUDED.endereco,parentesco=EXCLUDED.parentesco,financeiro=EXCLUDED.financeiro,assinante=EXCLUDED.assinante`,[req.params.id,clean(b.responsavel_nome),clean(b.responsavel_cpf),clean(b.responsavel_rg)||null,clean(b.responsavel_telefone),clean(b.responsavel_email)||null,clean(b.responsavel_endereco),clean(b.parentesco),financeiro==="1",assinante==="1"]);
    if(temSegundo)await client.query(`INSERT INTO matricula_responsaveis(matricula_id,ordem,nome,cpf,rg,telefone,email,endereco,parentesco,financeiro,assinante) VALUES($1,2,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(matricula_id,ordem) DO UPDATE SET nome=EXCLUDED.nome,cpf=EXCLUDED.cpf,rg=EXCLUDED.rg,telefone=EXCLUDED.telefone,email=EXCLUDED.email,endereco=EXCLUDED.endereco,parentesco=EXCLUDED.parentesco,financeiro=EXCLUDED.financeiro,assinante=EXCLUDED.assinante`,[req.params.id,clean(b.responsavel2_nome),clean(b.responsavel2_cpf),clean(b.responsavel2_rg)||null,clean(b.responsavel2_telefone),clean(b.responsavel2_email)||null,clean(b.responsavel2_endereco)||clean(b.responsavel_endereco),clean(b.responsavel2_parentesco),financeiro==="2",assinante==="2"]);
    else await client.query("DELETE FROM matricula_responsaveis WHERE matricula_id=$1 AND ordem=2",[req.params.id]);
    if(atual.rows[0].interessado_id)await client.query(`UPDATE interessados SET aluno_nome=$1,responsavel_nome=$2,telefone=$3,email=$4,turma_interesse=$5,plano_horas=$6,entrada=$7,saida=$8,atualizado_em=NOW() WHERE id=$9`,[clean(b.aluno_nome),clean(b.responsavel_nome),clean(b.responsavel_telefone),clean(b.responsavel_email)||null,clean(b.turma),clean(b.plano_horas),b.entrada,b.saida,atual.rows[0].interessado_id]);
    await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('matricula',$1,'matricula_atualizada',$2,$3)",[req.params.id,`Aluno: ${clean(b.aluno_nome)} | Ano: ${b.ano_letivo}`,req.session.user.id]);
    const numeroContrato=`${b.ano_letivo}-${String(req.params.id).padStart(5,"0")}`;
    const contrato=await client.query("UPDATE contratos SET numero=$1 WHERE matricula_id=$2 RETURNING id,numero,status",[numeroContrato,req.params.id]);
    await client.query("COMMIT");
    res.json({matricula:rows[0],contrato:contrato.rows[0]});
  }catch(e){
    await client.query("ROLLBACK");
    res.status(400).json({erro:e.code==="23505"?"Já existe uma matrícula deste interessado para esse ano letivo.":"Não foi possível atualizar a matrícula."});
  }finally{client.release()}
});
app.get("/api/financeiro",auth,podeFinanceiro,async(req,res)=>{
  const ano=Number.parseInt(req.query.ano,10)||(new Date().getFullYear()+1),busca=clean(req.query.q),status=clean(req.query.status);
  const filtros=["m.ano_letivo=$1"],valores=[ano];
  if(busca){valores.push(`%${busca}%`);filtros.push(`(m.aluno_nome ILIKE $${valores.length} OR m.responsavel_nome ILIKE $${valores.length})`)}
  const base=filtros.join(" AND ");
  let filtroStatus="";
  if(status==="atrasado")filtroStatus=" AND c.status='pendente' AND c.vencimento<CURRENT_DATE";
  else if(status==="pendente")filtroStatus=" AND c.status='pendente' AND c.vencimento>=CURRENT_DATE";
  else if(["pago","cancelado"].includes(status)){valores.push(status);filtroStatus=` AND c.status=$${valores.length}`}
  const lista=await db.query(`SELECT c.*,m.aluno_nome,COALESCE(rf.nome,m.responsavel_nome) responsavel_nome,COALESCE(rf.telefone,m.responsavel_telefone) responsavel_telefone,m.ano_letivo,(c.valor_original-c.desconto+c.acrescimo)::numeric(12,2) valor_atual,CASE WHEN c.status='pendente' AND c.vencimento<CURRENT_DATE THEN 'atrasado' ELSE c.status END status_exibicao FROM cobrancas c JOIN matriculas m ON m.id=c.matricula_id LEFT JOIN LATERAL (SELECT nome,telefone FROM matricula_responsaveis WHERE matricula_id=m.id AND financeiro=TRUE ORDER BY ordem LIMIT 1) rf ON TRUE WHERE ${base}${filtroStatus} ORDER BY c.vencimento,m.aluno_nome LIMIT 600`,valores);
  const resumoValores=busca?[ano,`%${busca}%`]:[ano];
  const resumo=await db.query(`SELECT COALESCE(SUM(CASE WHEN c.status='pago' THEN c.valor_pago ELSE 0 END),0)::numeric(12,2) recebido,COALESCE(SUM(CASE WHEN c.status='pendente' AND c.vencimento>=CURRENT_DATE THEN c.valor_original-c.desconto+c.acrescimo ELSE 0 END),0)::numeric(12,2) aberto,COALESCE(SUM(CASE WHEN c.status='pendente' AND c.vencimento<CURRENT_DATE THEN c.valor_original-c.desconto+c.acrescimo ELSE 0 END),0)::numeric(12,2) atrasado,COUNT(*) FILTER(WHERE c.status='pendente' AND c.vencimento<CURRENT_DATE)::int quantidade_atrasada FROM cobrancas c JOIN matriculas m ON m.id=c.matricula_id WHERE ${base}`,resumoValores);
  res.json({ano,resumo:resumo.rows[0],cobrancas:lista.rows});
});
app.put("/api/financeiro/:id",auth,podeFinanceiro,async(req,res)=>{
  if(!idValido(req.params.id))return res.status(400).json({erro:"Cobrança inválida."});
  const atual=(await db.query("SELECT * FROM cobrancas WHERE id=$1",[req.params.id])).rows[0];
  if(!atual)return res.status(404).json({erro:"Cobrança não encontrada."});
  const desconto=Number(req.body.desconto||0),acrescimo=Number(req.body.acrescimo||0),status=clean(req.body.status),formas=["pix","dinheiro","boleto","cartao","transferencia","outro"];
  if(!Number.isFinite(desconto)||desconto<0||!Number.isFinite(acrescimo)||acrescimo<0)return res.status(400).json({erro:"Informe desconto e acréscimo válidos."});
  const valorAtual=Number(atual.valor_original)-desconto+acrescimo;
  if(valorAtual<0)return res.status(400).json({erro:"O desconto não pode ser maior que o valor da cobrança somado ao acréscimo."});
  if(!["pendente","pago","cancelado"].includes(status))return res.status(400).json({erro:"Selecione uma situação válida."});
  const forma=clean(req.body.forma_pagamento),valorInformado=req.body.valor_pago===""||req.body.valor_pago==null?valorAtual:Number(req.body.valor_pago);
  if(status==="pago"&&(!Number.isFinite(valorInformado)||valorInformado<0))return res.status(400).json({erro:"Informe um valor pago válido."});
  if(status==="pago"&&!formas.includes(forma))return res.status(400).json({erro:"Selecione a forma de pagamento."});
  const {rows}=await db.query(`UPDATE cobrancas SET desconto=$1,acrescimo=$2,status=$3,valor_pago=CASE WHEN $3='pago' THEN $4 ELSE NULL END,pago_em=CASE WHEN $3='pago' THEN COALESCE($5::date,CURRENT_DATE) ELSE NULL END,forma_pagamento=CASE WHEN $3='pago' THEN $6 ELSE NULL END,observacoes=$7,atualizado_por=$8,atualizado_em=NOW() WHERE id=$9 RETURNING *`,[desconto,acrescimo,status,status==="pago"?valorInformado:null,req.body.pago_em||null,forma||null,clean(req.body.observacoes)||null,req.session.user.id,req.params.id]);
  await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('cobranca',$1,'cobranca_atualizada',$2,$3)",[req.params.id,`Situação: ${status} | Valor: ${valorAtual.toFixed(2)}`,req.session.user.id]);
  res.json(rows[0]);
});
app.get("/api/financeiro/relatorio.csv",auth,podeRelatorioFinanceiro,async(req,res)=>{
  const {ano,rows}=await consultarRelatorioFinanceiro(req),labels={pendente:"Em aberto",atrasado:"Atrasada",pago:"Paga",cancelado:"Cancelada"},formas={pix:"PIX",dinheiro:"Dinheiro",boleto:"Boleto",cartao:"Cartão",transferencia:"Transferência",outro:"Outro"};
  const cabecalho=["Aluno","Responsável","Tipo","Parcela","Ano letivo","Vencimento","Valor original","Desconto","Acréscimo","Valor atual","Situação","Data do pagamento","Valor pago","Forma de pagamento","Observações"];
  const linhas=rows.map(x=>[x.aluno_nome,x.responsavel_nome,x.tipo==="matricula"?"Matrícula":"Mensalidade",x.tipo==="matricula"?"—":`${x.parcela_numero}/12`,x.ano_letivo,dataRelatorio(x.vencimento),Number(x.valor_original).toFixed(2).replace(".",","),Number(x.desconto).toFixed(2).replace(".",","),Number(x.acrescimo).toFixed(2).replace(".",","),Number(x.valor_atual).toFixed(2).replace(".",","),labels[x.status_exibicao],dataRelatorio(x.pago_em),x.valor_pago==null?"":Number(x.valor_pago).toFixed(2).replace(".",","),formas[x.forma_pagamento]||x.forma_pagamento||"",x.observacoes||""]);
  const csv="\uFEFF"+[cabecalho,...linhas].map(l=>l.map(csvCampo).join(";")).join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="financeiro-${ano}.csv"`);res.send(csv);
});
app.get("/api/financeiro/relatorio.pdf",auth,podeRelatorioFinanceiro,async(req,res)=>{
  const {ano,rows}=await consultarRelatorioFinanceiro(req),labels={pendente:"Em aberto",atrasado:"Atrasada",pago:"Paga",cancelado:"Cancelada"};
  const recebido=rows.reduce((s,x)=>s+(x.status==="pago"?Number(x.valor_pago||0):0),0),aberto=rows.reduce((s,x)=>s+(x.status==="pendente"&&x.status_exibicao!=="atrasado"?Number(x.valor_atual):0),0),atrasado=rows.reduce((s,x)=>s+(x.status_exibicao==="atrasado"?Number(x.valor_atual):0),0);
  const doc=new PDFDocument({size:"A4",layout:"landscape",margins:{top:35,bottom:35,left:35,right:35},bufferPages:true,info:{Title:`Relatório financeiro ${ano}`,Author:ESCOLA.nome}});
  res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`inline; filename="relatorio-financeiro-${ano}.pdf"`);doc.pipe(res);
  const cabecalho=()=>{doc.image(logoPath,35,28,{fit:[46,46]});doc.font("Helvetica-Bold").fontSize(12).fillColor("#32185a").text(ESCOLA.nome,90,33,{width:500});doc.font("Helvetica").fontSize(7.5).fillColor("#555555").text(`${ESCOLA.cnpj} | ${ESCOLA.telefone} | ${ESCOLA.email}`,90,51,{width:600});doc.moveTo(35,80).lineTo(807,80).strokeColor("#6c3aa5").stroke();doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(`RELATÓRIO FINANCEIRO — ${ano}`,35,94,{width:772,align:"center"});doc.font("Helvetica").fontSize(8).fillColor("#666666").text(`Emitido em ${new Date().toLocaleString("pt-BR")} · ${rows.length} cobrança(s)`,35,116,{width:772,align:"center"});doc.roundedRect(35,137,240,43,7).fillAndStroke("#eef8ec","#c8dfc2");doc.roundedRect(300,137,240,43,7).fillAndStroke("#f7f4fa","#d8cae8");doc.roundedRect(565,137,242,43,7).fillAndStroke("#fff0ee","#f1c4bd");doc.font("Helvetica").fontSize(8).fillColor("#555555").text("RECEBIDO",48,147).text("EM ABERTO",313,147).text("ATRASADO",578,147);doc.font("Helvetica-Bold").fontSize(14).fillColor("#277133").text(`R$ ${moeda(recebido)}`,48,160,{width:210});doc.fillColor("#32185a").text(`R$ ${moeda(aberto)}`,313,160,{width:210});doc.fillColor("#b42318").text(`R$ ${moeda(atrasado)}`,578,160,{width:210});doc.y=202};
  const tabelaCabecalho=()=>{doc.rect(35,doc.y,772,20).fill("#32185a");doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");const y=doc.y+6;doc.text("Aluno / responsável",42,y,{width:150});doc.text("Cobrança",200,y,{width:85});doc.text("Vencimento",290,y,{width:65});doc.text("Valor",365,y,{width:75});doc.text("Situação",450,y,{width:70});doc.text("Pagamento",530,y,{width:75});doc.text("Valor pago",615,y,{width:75});doc.text("Forma",700,y,{width:95});doc.y+=20};
  cabecalho();tabelaCabecalho();
  rows.forEach((x,i)=>{if(doc.y>535){doc.addPage();cabecalho();tabelaCabecalho()}const y=doc.y,altura=31;if(i%2===0)doc.rect(35,y,772,altura).fill("#f7f8fa");doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#111111").text(x.aluno_nome,42,y+5,{width:150,ellipsis:true});doc.font("Helvetica").fontSize(6.5).fillColor("#666666").text(x.responsavel_nome,42,y+16,{width:150,ellipsis:true});doc.fontSize(7.2).fillColor("#222222").text(x.tipo==="matricula"?"Matrícula":`Mensalidade ${x.parcela_numero}/12`,200,y+10,{width:85});doc.text(dataRelatorio(x.vencimento),290,y+10,{width:65});doc.font("Helvetica-Bold").text(`R$ ${moeda(x.valor_atual)}`,365,y+10,{width:75});doc.font("Helvetica").text(labels[x.status_exibicao],450,y+10,{width:70});doc.text(dataRelatorio(x.pago_em)||"—",530,y+10,{width:75});doc.text(x.valor_pago==null?"—":`R$ ${moeda(x.valor_pago)}`,615,y+10,{width:75});doc.text(x.forma_pagamento||"—",700,y+10,{width:95});doc.y=y+altura});
  const paginas=doc.bufferedPageRange();for(let i=0;i<paginas.count;i++){doc.switchToPage(paginas.start+i);doc.font("Helvetica").fontSize(7).fillColor("#777777").text(`Página ${i+1} de ${paginas.count}`,700,565,{width:107,align:"right"})}doc.end();
});
app.get("/api/financeiro/:id/recibo",auth,podeFinanceiro,async(req,res)=>{
  if(!idValido(req.params.id))return res.status(400).json({erro:"Cobrança inválida."});
  const {rows}=await db.query(`SELECT c.*,m.aluno_nome,m.ano_letivo,m.responsavel_nome,m.responsavel_cpf,COALESCE(r.nome,m.responsavel_nome) pagador_nome,COALESCE(r.cpf,m.responsavel_cpf) pagador_cpf FROM cobrancas c JOIN matriculas m ON m.id=c.matricula_id LEFT JOIN LATERAL (SELECT nome,cpf FROM matricula_responsaveis WHERE matricula_id=m.id AND financeiro=TRUE ORDER BY ordem LIMIT 1) r ON TRUE WHERE c.id=$1`,[req.params.id]);
  const x=rows[0];
  if(!x)return res.status(404).json({erro:"Cobrança não encontrada."});
  if(x.status!=="pago")return res.status(400).json({erro:"O recibo só pode ser gerado para uma cobrança paga."});
  const numero=`REC-${x.ano_letivo}-${String(x.id).padStart(6,"0")}`,referencia=x.tipo==="matricula"?`matrícula do ano letivo de ${x.ano_letivo}`:`mensalidade ${x.parcela_numero}/12 do ano letivo de ${x.ano_letivo}`,formas={pix:"PIX",dinheiro:"Dinheiro",boleto:"Boleto",cartao:"Cartão",transferencia:"Transferência",outro:"Outro"};
  const dataPagamento=dataRelatorio(x.pago_em);
  const doc=new PDFDocument({size:"A4",margins:{top:55,bottom:55,left:60,right:60},info:{Title:`Recibo ${numero}`,Author:ESCOLA.nome,Subject:"Recibo de pagamento"}});
  res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`inline; filename="recibo-${numero}.pdf"`);doc.pipe(res);
  doc.save().opacity(.045).image(logoPath,135,205,{fit:[325,325]}).restore();
  doc.image(logoPath,60,48,{fit:[74,74]});
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#4b2482").text(ESCOLA.nome,145,58,{width:390});
  doc.font("Helvetica").fontSize(8.5).fillColor("#333333").text(`CNPJ: ${ESCOLA.cnpj}\n${ESCOLA.endereco}\n${ESCOLA.telefone} | ${ESCOLA.email}`,145,78,{width:390,lineGap:2});
  doc.moveTo(60,132).lineTo(535,132).lineWidth(1).strokeColor("#6c3aa5").stroke();
  doc.font("Helvetica-Bold").fontSize(19).fillColor("#32185a").text("RECIBO DE PAGAMENTO",60,160,{width:475,align:"center"});
  doc.font("Helvetica").fontSize(9).fillColor("#666666").text(`Nº ${numero}`,60,188,{width:475,align:"center"});
  doc.roundedRect(60,225,475,78,10).fillAndStroke("#f4eef9","#d8cae8");
  doc.font("Helvetica").fontSize(10).fillColor("#555555").text("VALOR RECEBIDO",80,244);
  doc.font("Helvetica-Bold").fontSize(25).fillColor("#32185a").text(`R$ ${moeda(x.valor_pago)}`,80,263,{width:435});
  doc.font("Helvetica").fontSize(11).fillColor("#111111").text(`Recebemos de `,60,345,{continued:true});doc.font("Helvetica-Bold").text(x.pagador_nome||"Responsável financeiro",{continued:true});doc.font("Helvetica").text(`, CPF ${x.pagador_cpf||"não informado"}, o valor acima indicado, referente à ${referencia} do(a) aluno(a) `,{continued:true});doc.font("Helvetica-Bold").text(x.aluno_nome,{continued:true});doc.font("Helvetica").text(".",{align:"justify",lineGap:4});
  doc.moveDown(1.2);doc.font("Helvetica").fontSize(10).text(`Data do pagamento: `,{continued:true});doc.font("Helvetica-Bold").text(dataPagamento);
  doc.font("Helvetica").text(`Forma de pagamento: `,{continued:true});doc.font("Helvetica-Bold").text(formas[x.forma_pagamento]||x.forma_pagamento||"Não informada");
  if(x.observacoes){doc.moveDown(.7);doc.font("Helvetica").text(`Observações: ${x.observacoes}`,{width:475})}
  doc.moveDown(4);const y=doc.y;doc.moveTo(150,y).lineTo(445,y).strokeColor("#333333").stroke();doc.font("Helvetica").fontSize(9).fillColor("#111111").text(`${ESCOLA.nome}\n${ESCOLA.representante}`,150,y+7,{width:295,align:"center"});
  doc.fontSize(7.5).fillColor("#666666").text(`Documento emitido pelo CRM em ${new Date().toLocaleString("pt-BR")}. Autenticidade vinculada ao registro ${numero}.`,60,760,{width:475,align:"center"});
  doc.end();
});
app.get("/api/usuarios",auth,permitir("administrador"),async(req,res)=>{const {rows}=await db.query("SELECT id,nome,email,usuario,cpf,perfil,ativo,criado_em FROM usuarios ORDER BY ativo DESC,nome");res.json(rows)});
app.post("/api/usuarios",auth,permitir("administrador"),async(req,res)=>{const nome=clean(req.body.nome),email=clean(req.body.email).toLowerCase(),usuario=clean(req.body.usuario).toLowerCase(),cpf=somenteDigitos(req.body.cpf),perfil=clean(req.body.perfil),senha=String(req.body.senha||""),confirmacao=String(req.body.confirmar_senha||"");if(!nomeCompleto(nome))return res.status(400).json({erro:"Informe o nome completo do usuário."});if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({erro:"Informe um e-mail válido."});if(!usuarioValido(usuario))return res.status(400).json({erro:"O usuário deve começar com uma letra e ter de 3 a 40 caracteres, usando apenas letras, números, ponto, traço ou sublinhado."});if(!cpfValido(cpf))return res.status(400).json({erro:"Informe um CPF válido."});if(!perfisPermitidos.includes(perfil))return res.status(400).json({erro:"Selecione um perfil válido."});if(senha.length<8)return res.status(400).json({erro:"A senha deve ter pelo menos 8 caracteres."});if(senha!==confirmacao)return res.status(400).json({erro:"A senha e a confirmação não são iguais."});try{const hash=await bcrypt.hash(senha,12);const {rows}=await db.query("INSERT INTO usuarios(nome,email,usuario,cpf,senha_hash,perfil,ativo) VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING id,nome,email,usuario,cpf,perfil,ativo,criado_em",[nome,email,usuario,cpf,hash,perfil]);await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('usuario',$1,'usuario_criado',$2,$3)",[rows[0].id,`Usuário: ${rows[0].nome} | Perfil: ${rows[0].perfil}`,req.session.user.id]);res.status(201).json(rows[0])}catch(e){if(e.code==="23505")return res.status(400).json({erro:"E-mail, usuário ou CPF já cadastrado."});throw e}});
app.put("/api/usuarios/:id",auth,permitir("administrador"),async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Usuário inválido."});const nome=clean(req.body.nome),email=clean(req.body.email).toLowerCase(),usuario=clean(req.body.usuario).toLowerCase(),cpf=somenteDigitos(req.body.cpf),perfil=clean(req.body.perfil),senha=String(req.body.senha||""),confirmacao=String(req.body.confirmar_senha||""),ativo=req.body.ativo===true||String(req.body.ativo)==="true";if(!nomeCompleto(nome))return res.status(400).json({erro:"Informe o nome completo do usuário."});if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({erro:"Informe um e-mail válido."});if(!usuarioValido(usuario))return res.status(400).json({erro:"Informe um nome de usuário válido."});if(!cpfValido(cpf))return res.status(400).json({erro:"Informe um CPF válido."});if(!perfisPermitidos.includes(perfil))return res.status(400).json({erro:"Selecione um perfil válido."});if(senha&&senha.length<8)return res.status(400).json({erro:"A nova senha deve ter pelo menos 8 caracteres."});if(senha!==confirmacao)return res.status(400).json({erro:"A senha e a confirmação não são iguais."});if(Number(req.params.id)===Number(req.session.user.id)&&(!ativo||perfil!=="administrador"))return res.status(400).json({erro:"Você não pode desativar sua própria conta nem remover seu acesso de administrador."});try{const valores=[nome,email,usuario,cpf,perfil,ativo,req.params.id];let sql="UPDATE usuarios SET nome=$1,email=$2,usuario=$3,cpf=$4,perfil=$5,ativo=$6 WHERE id=$7 RETURNING id,nome,email,usuario,cpf,perfil,ativo,criado_em";if(senha){valores.splice(6,0,await bcrypt.hash(senha,12));sql="UPDATE usuarios SET nome=$1,email=$2,usuario=$3,cpf=$4,perfil=$5,ativo=$6,senha_hash=$7 WHERE id=$8 RETURNING id,nome,email,usuario,cpf,perfil,ativo,criado_em"}const {rows}=await db.query(sql,valores);if(!rows[0])return res.status(404).json({erro:"Usuário não encontrado."});await db.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('usuario',$1,'usuario_atualizado',$2,$3)",[rows[0].id,`Usuário: ${rows[0].nome} | Perfil: ${rows[0].perfil} | Status: ${rows[0].ativo?'ativo':'inativo'}${senha?' | Senha alterada':''}`,req.session.user.id]);if(Number(req.params.id)===Number(req.session.user.id)){req.session.user={...req.session.user,nome:rows[0].nome,email:rows[0].email,usuario:rows[0].usuario,perfil:rows[0].perfil}}res.json(rows[0])}catch(e){if(e.code==="23505")return res.status(400).json({erro:"E-mail, usuário ou CPF já cadastrado."});throw e}});
app.post("/api/usuarios/:id/redefinir-senha",auth,permitir("administrador"),async(req,res)=>{if(!idValido(req.params.id))return res.status(400).json({erro:"Usuário inválido."});const senha=String(req.body.senha||""),confirmacao=String(req.body.confirmar_senha||"");if(senha.length<8)return res.status(400).json({erro:"A nova senha deve ter pelo menos 8 caracteres."});if(senha!==confirmacao)return res.status(400).json({erro:"A senha e a confirmação não são iguais."});const client=await db.connect();try{await client.query("BEGIN");const {rows}=await client.query("UPDATE usuarios SET senha_hash=$1 WHERE id=$2 AND ativo=TRUE RETURNING id,nome",[await bcrypt.hash(senha,12),req.params.id]);if(!rows[0]){await client.query("ROLLBACK");return res.status(404).json({erro:"Usuário ativo não encontrado."})}await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('usuario',$1,'senha_redefinida',$2,$3)",[req.params.id,`Senha redefinida pelo administrador ${req.session.user.nome}.`,req.session.user.id]);await client.query(`DELETE FROM "session" WHERE sid<>$1 AND sess->'user'->>'id'=$2`,[req.sessionID,String(req.params.id)]);await client.query("COMMIT");res.json({ok:true,nome:rows[0].nome,sessoes_encerradas:true})}catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}});
const tabelasBackup=["usuarios","interessados","interessado_contatos","matriculas","matricula_responsaveis","contratos","cobrancas","historico"];
app.get("/api/backup/resumo",auth,permitir("administrador"),async(req,res)=>{const [resultados,automatico]=await Promise.all([Promise.all(tabelasBackup.map(tabela=>db.query(`SELECT COUNT(*)::int total FROM ${tabela}`))),obterStatusBackupAutomatico()]);const totais=Object.fromEntries(tabelasBackup.map((tabela,i)=>[tabela,resultados[i].rows[0].total]));res.json({interessados:totais.interessados,matriculas:totais.matriculas,responsaveis:totais.matricula_responsaveis,contratos:totais.contratos,cobrancas:totais.cobrancas,usuarios:totais.usuarios,automatico})});
async function montarBackup(client,usuario){const dados={};for(const tabela of tabelasBackup){const {rows}=await client.query(`SELECT * FROM ${tabela} ORDER BY id`);dados[tabela]=rows}return{formato:"crm-gestao-escolar-backup",versao:1,gerado_em:new Date().toISOString(),gerado_por:{id:usuario.id,nome:usuario.nome},escola:{nome:ESCOLA.nome,cnpj:ESCOLA.cnpj},dados}}
function carimboBackup(data=new Date()){const iso=data.toISOString();return `${iso.slice(0,10)}-${iso.slice(11,19).replace(/:/g,"-")}-${iso.slice(20,23)}`}
function diaLocal(data=new Date()){return `${data.getFullYear()}-${String(data.getMonth()+1).padStart(2,"0")}-${String(data.getDate()).padStart(2,"0")}`}
async function obterStatusBackupAutomatico(){if(!backupAutomaticoAtivo)return{ativo:false,horario:horarioBackupAutomatico,total:0,ultimo:null,executando:backupAutomaticoExecutando};try{const arquivos=(await fs.readdir(pastaBackups,{withFileTypes:true})).filter(x=>x.isFile()&&x.name.startsWith("backup-automatico-")&&x.name.endsWith(".json")).map(x=>x.name).sort();if(!arquivos.length)return{ativo:true,horario:horarioBackupAutomatico,total:0,ultimo:null,executando:backupAutomaticoExecutando};const nome=arquivos.at(-1),stat=await fs.stat(path.join(pastaBackups,nome));return{ativo:true,horario:horarioBackupAutomatico,total:arquivos.length,ultimo:{nome,criado_em:stat.mtime.toISOString(),tamanho_bytes:stat.size},executando:backupAutomaticoExecutando}}catch(e){if(e.code==="ENOENT")return{ativo:true,horario:horarioBackupAutomatico,total:0,ultimo:null,executando:backupAutomaticoExecutando};throw e}}
async function salvarBackupAutomatico(usuario={id:null,nome:"Sistema"},prefixo="backup-automatico"){if(backupAutomaticoExecutando)throw Object.assign(new Error("Já existe um backup em andamento."),{status:409});backupAutomaticoExecutando=true;const client=await db.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const backup=await montarBackup(client,usuario);await client.query("COMMIT");const nome=`${prefixo}-${carimboBackup(new Date(backup.gerado_em))}.json`;await fs.mkdir(pastaBackups,{recursive:true});const conteudo=JSON.stringify(backup,null,2);await fs.writeFile(path.join(pastaBackups,nome),conteudo,{encoding:"utf8",mode:0o600});return{nome,caminho:`backups/${nome}`,tamanho_bytes:Buffer.byteLength(conteudo)}}catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release();backupAutomaticoExecutando=false}}
function horarioAutomaticoJaPassou(data=new Date()){const [hora,minuto]=horarioBackupAutomatico.split(":").map(Number);return data.getHours()>hora||(data.getHours()===hora&&data.getMinutes()>=minuto)}
function agendarProximoBackup(){if(!backupAutomaticoAtivo)return;clearTimeout(timerBackupAutomatico);const agora=new Date(),[hora,minuto]=horarioBackupAutomatico.split(":").map(Number),proximo=new Date(agora);proximo.setHours(hora,minuto,0,0);if(proximo<=agora)proximo.setDate(proximo.getDate()+1);timerBackupAutomatico=setTimeout(async()=>{try{await salvarBackupAutomatico()}catch(e){console.error("Falha no backup automático:",e.message)}finally{agendarProximoBackup()}},proximo-agora);timerBackupAutomatico.unref?.()}
async function iniciarBackupAutomatico(){if(!backupAutomaticoAtivo){console.log("Backup automático desativado.");return}try{const status=await obterStatusBackupAutomatico(),ultimoDia=status.ultimo?diaLocal(new Date(status.ultimo.criado_em)):"";if(horarioAutomaticoJaPassou()&&ultimoDia!==diaLocal())await salvarBackupAutomatico()}catch(e){console.error("Não foi possível executar o backup automático pendente:",e.message)}agendarProximoBackup();console.log(`Backup automático agendado diariamente para ${horarioBackupAutomatico}.`)}
function validarArquivoBackup(backup,emailAtual){if(!backup||backup.formato!=="crm-gestao-escolar-backup"||Number(backup.versao)!==1)throw Object.assign(new Error("O arquivo selecionado não é um backup válido do CRM."),{status:400});if(somenteDigitos(backup.escola?.cnpj)!==somenteDigitos(ESCOLA.cnpj))throw Object.assign(new Error("Este backup pertence a outro cadastro de escola."),{status:400});for(const tabela of tabelasBackup){if(!Array.isArray(backup.dados?.[tabela]))throw Object.assign(new Error(`O backup está incompleto: faltam os dados de ${tabela}.`),{status:400});if(backup.dados[tabela].length>100000)throw Object.assign(new Error("O backup ultrapassa o limite de registros permitido."),{status:400})}const administrador=backup.dados.usuarios.find(u=>String(u.email||"").toLowerCase()===String(emailAtual||"").toLowerCase()&&u.perfil==="administrador"&&u.ativo===true);if(!administrador)throw Object.assign(new Error("O backup não contém sua conta atual como administrador ativo. A restauração foi bloqueada para evitar perda de acesso."),{status:400});return administrador}
app.get("/api/backup/download",auth,permitir("administrador"),async(req,res)=>{const client=await db.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const backup=await montarBackup(client,req.session.user);await client.query("COMMIT");const geradoEm=new Date(backup.gerado_em),arquivo=`backup-gestao-escolar-${geradoEm.toISOString().slice(0,10)}-${geradoEm.toISOString().slice(11,19).replace(/:/g,"-")}.json`;res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="${arquivo}"`);res.setHeader("Cache-Control","no-store");res.send(JSON.stringify(backup,null,2))}catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}});
app.post("/api/backup/automatico",auth,permitir("administrador"),async(req,res)=>{try{const arquivo=await salvarBackupAutomatico(req.session.user);res.status(201).json({ok:true,arquivo,status:await obterStatusBackupAutomatico()})}catch(e){res.status(e.status||500).json({erro:e.status?e.message:"Não foi possível criar o backup automático agora."})}});
app.post("/api/backup/restaurar",auth,permitir("administrador"),async(req,res)=>{if(clean(req.body?.confirmacao)!=="RESTAURAR")return res.status(400).json({erro:"Digite RESTAURAR para confirmar a operação."});let administrador;try{administrador=validarArquivoBackup(req.body?.backup,req.session.user.email)}catch(e){return res.status(e.status||400).json({erro:e.message})}const client=await db.connect();let arquivoSeguranca="";try{await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");const atual=await montarBackup(client,req.session.user),agora=new Date(),nome=`backup-antes-restauracao-${agora.toISOString().slice(0,10)}-${agora.toISOString().slice(11,19).replace(/:/g,"-")}.json`,pasta=path.join(root,"../backups");await fs.mkdir(pasta,{recursive:true});await fs.writeFile(path.join(pasta,nome),JSON.stringify(atual,null,2),{encoding:"utf8",mode:0o600});arquivoSeguranca=`backups/${nome}`;for(const tabela of [...tabelasBackup].reverse())await client.query(`DELETE FROM ${tabela}`);for(const tabela of tabelasBackup){if(tabela==="cobrancas")await client.query("DELETE FROM cobrancas");const colunasBanco=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[tabela])).rows.map(x=>x.column_name);for(const registro of req.body.backup.dados[tabela]){const colunas=colunasBanco.filter(coluna=>Object.hasOwn(registro,coluna));if(!colunas.length)throw new Error(`Nenhuma coluna válida encontrada em ${tabela}.`);const nomes=colunas.map(coluna=>`"${coluna}"`).join(","),marcadores=colunas.map((_,i)=>`$${i+1}`).join(","),valores=colunas.map(coluna=>registro[coluna]);await client.query(`INSERT INTO "${tabela}" (${nomes}) VALUES (${marcadores})`,valores)}await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE(MAX(id),1),COUNT(*)>0) FROM ${tabela}`,[tabela])}await client.query("COMMIT");req.session.user={id:administrador.id,nome:administrador.nome,email:administrador.email,usuario:administrador.usuario,perfil:administrador.perfil};res.json({ok:true,arquivo_seguranca:arquivoSeguranca,registros:Object.fromEntries(tabelasBackup.map(tabela=>[tabela,req.body.backup.dados[tabela].length]))})}catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Falha ao restaurar backup:",e);res.status(400).json({erro:"Não foi possível restaurar o backup. Nenhum dado foi substituído.",arquivo_seguranca:arquivoSeguranca||null})}finally{client.release()}});
app.get("/api/contratos",auth,podeConsultar,async(req,res)=>{const {rows}=await db.query(`SELECT c.id,c.numero,c.status,c.criado_em,m.aluno_nome,m.responsavel_nome,m.ano_letivo FROM contratos c JOIN matriculas m ON m.id=c.matricula_id ORDER BY c.criado_em DESC LIMIT 300`);res.json(rows);});
app.get("/api/contratos/:id/pdf",auth,podeConsultar,async(req,res)=>{
  if(!idValido(req.params.id))return res.status(400).end();
  const contrato=await db.query(`SELECT c.numero,m.* FROM contratos c JOIN matriculas m ON m.id=c.matricula_id WHERE c.id=$1`,[req.params.id]);
  if(!contrato.rows[0])return res.status(404).end();
  const x=contrato.rows[0];
  const responsaveis=(await db.query("SELECT * FROM matricula_responsaveis WHERE matricula_id=$1 ORDER BY ordem",[x.id])).rows;
  const financeiro=responsaveis.find(r=>r.financeiro)||responsaveis[0];
  const assinante=responsaveis.find(r=>r.assinante)||responsaveis[0];
  const fundamental=fundamental1(x.turma);
  const segmento=fundamental?"ENSINO FUNDAMENTAL - ANOS INICIAIS":"EDUCAÇÃO INFANTIL";
  const doc=new PDFDocument({size:"A4",margins:{top:130,bottom:52,left:55,right:55},bufferPages:true,info:{Title:`Contrato ${x.numero}`,Author:ESCOLA.nome,Subject:"Prestação de serviços educacionais"}});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`inline; filename="contrato-${x.numero}.pdf"`);
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  doc.pipe(res);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111111").text("CONTRATO DE PRESTAÇÃO DE SERVIÇOS EDUCACIONAIS",{align:"center"});
  doc.moveDown(.25).fontSize(10).text(`${segmento} | ANO LETIVO ${x.ano_letivo}`,{align:"center"});
  doc.moveDown(.25).font("Helvetica").fontSize(8.5).text(`Contrato nº ${x.numero}`,{align:"center"});

  tituloSecao(doc,"1. IDENTIFICAÇÃO DO ALUNO");
  linhaDado(doc,"Nome",x.aluno_nome);
  linhaDado(doc,"Data de nascimento",dataRelatorio(x.aluno_nascimento));
  linhaDado(doc,"CPF",x.aluno_cpf||"Não informado");
  linhaDado(doc,"Turma",x.turma);
  doc.moveDown(.5);

  tituloSecao(doc,"2. CONTRATANTE(S)");
  responsaveis.forEach((r,i)=>{
    if(doc.y>doc.page.height-180)doc.addPage();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#4b2482").text(`RESPONSÁVEL ${i+1}`);
    linhaDado(doc,"Nome",r.nome);
    linhaDado(doc,"CPF",r.cpf);
    if(r.rg)linhaDado(doc,"RG",r.rg);
    linhaDado(doc,"Parentesco",r.parentesco);
    linhaDado(doc,"Telefone",r.telefone);
    if(r.email)linhaDado(doc,"E-mail",r.email);
    linhaDado(doc,"Endereço",r.endereco);
    if(r.financeiro)linhaDado(doc,"Responsável financeiro","SIM");
    if(r.assinante)linhaDado(doc,"Assinante do contrato","SIM");
    doc.moveDown(.65);
  });

  tituloSecao(doc,"3. CONTRATADA");
  paragrafo(doc,"Pessoa jurídica de direito privado qualificada pelos seguintes dados:");
  linhaDado(doc,"Razão social",ESCOLA.nome);
  linhaDado(doc,"CNPJ",ESCOLA.cnpj);
  linhaDado(doc,"Endereço",ESCOLA.endereco);
  linhaDado(doc,"Telefone",ESCOLA.telefone);
  linhaDado(doc,"E-mail",ESCOLA.email);
  linhaDado(doc,"Representante legal",ESCOLA.representante);
  doc.moveDown(.4);
  paragrafo(doc,"A CONTRATADA é representada neste ato na forma de seu contrato social.");

  tituloSecao(doc,"4. DO OBJETO");
  if(fundamental){
    paragrafo(doc,`CLÁUSULA 1ª - O presente contrato tem por objeto a prestação de serviços educacionais do Ensino Fundamental - Anos Iniciais, para a turma ${x.turma}, durante o ano letivo de ${x.ano_letivo}.`);
    paragrafo(doc,"CLÁUSULA 2ª - Os serviços abrangem as atividades curriculares, pedagógicas e de desenvolvimento integral previstas no Projeto Político-Pedagógico da CONTRATADA, na Base Nacional Comum Curricular e na legislação educacional vigente.");
  }else{
    paragrafo(doc,`CLÁUSULA 1ª - O presente contrato tem por objeto a prestação de serviços educacionais de Educação Infantil para a turma ${x.turma}, durante o ano letivo de ${x.ano_letivo}.`);
    paragrafo(doc,"CLÁUSULA 2ª - Os serviços educacionais abrangem atividades pedagógicas, cuidados assistenciais, recreativos e de desenvolvimento integral da criança, conforme o Projeto Político-Pedagógico da CONTRATADA e a legislação educacional vigente.");
  }

  tituloSecao(doc,"5. FUNDAMENTOS LEGAIS");
  paragrafo(doc,"CLÁUSULA 3ª - O presente contrato é regido pela Constituição Federal, pela Lei nº 9.394/96 (LDB), pelo Estatuto da Criança e do Adolescente (Lei nº 8.069/90), pelo Código de Defesa do Consumidor (Lei nº 8.078/90), pelo Código Civil (Lei nº 10.406/2002) e pelas demais normas aplicáveis.");

  tituloSecao(doc,"6. DA VIGÊNCIA");
  paragrafo(doc,`CLÁUSULA 4ª - Este contrato terá vigência de 1º de janeiro de ${x.ano_letivo} a 31 de dezembro de ${x.ano_letivo}, podendo ser rescindido conforme as disposições deste instrumento.`);

  tituloSecao(doc,"7. HORÁRIO DE FUNCIONAMENTO E PERÍODO CONTRATADO");
  paragrafo(doc,"CLÁUSULA 5ª - O horário de funcionamento da CONTRATADA é de segunda a sexta-feira, das 07:00 às 18:40, exceto feriados, recessos e períodos previstos no calendário escolar.");
  paragrafo(doc,"Parágrafo 1º - O horário pedagógico regular ocorre das 08:00 às 12:00 e das 13:00 às 17:00, podendo o aluno permanecer em período estendido conforme contratação.");
  paragrafo(doc,`Parágrafo 2º - O plano contratado permite permanência de até ${x.plano_horas} por dia, com horário habitual de entrada às ${String(x.entrada).slice(0,5)} e saída às ${String(x.saida).slice(0,5)}.`);

  tituloSecao(doc,"8. DA REMUNERAÇÃO");
  paragrafo(doc,`CLÁUSULA 6ª - Pelos serviços prestados, o(s) CONTRATANTE(S) pagará(ão) à CONTRATADA 13 (treze) parcelas anuais no valor de R$ ${moeda(x.mensalidade)} cada, com vencimento no dia ${x.vencimento_dia} de cada mês, conforme as condições informadas no ato da matrícula.`);
  paragrafo(doc,"Parágrafo 1º - Os valores poderão ser reajustados anualmente, mediante comunicação prévia, para preservação do equilíbrio econômico-financeiro do contrato.");
  paragrafo(doc,"Parágrafo 2º - O não comparecimento do aluno não isenta o pagamento da mensalidade.");
  paragrafo(doc,fundamental?"Parágrafo 3º - Atividades ou programas recreativos oferecidos durante as férias escolares não integram a mensalidade regular e dependerão de contratação e pagamento específicos.":"Parágrafo 3º - Para os meses de férias escolares, janeiro e julho, será acrescido o valor de 30% para as turmas do Berçário ao Pré-2, mediante contratação antecipada e pagamento adicional.");
  paragrafo(doc,"Parágrafo 4º - A CONTRATADA poderá estabelecer critérios de descontos individuais ou política geral de descontos por meio de adendo contratual. A concessão estará vinculada à regularidade financeira e não obriga sua manutenção em anos subsequentes.");
  paragrafo(doc,"Parágrafo 5º - O(s) CONTRATANTE(S) declara(m) ter recebido previamente as condições financeiras deste contrato, conhecendo-as e aceitando-as livremente.");

  tituloSecao(doc,"9. DO PERÍODO EXTRACURRICULAR");
  paragrafo(doc,fundamental?"CLÁUSULA 7ª - Fora dos horários de aula, poderão ser prestadas atividades recreativas, culturais e de estudos orientados, conforme o período contratado.":"CLÁUSULA 7ª - Fora dos horários de aula, poderão ser prestadas atividades recreativas e culturais, incluindo jogos, filmes, repouso, brincadeiras, literatura e demais cuidados, conforme o período contratado.");
  paragrafo(doc,"Parágrafo 1º - O(s) CONTRATANTE(S) declara(m) estar ciente(s) de que essas atividades possuem finalidade cultural e recreativa, não constituem atividade pedagógica específica e não integram a grade curricular.");
  paragrafo(doc,"Parágrafo 2º - As atividades extracurriculares não estão sujeitas à avaliação acadêmica e poderão ocorrer em grupos polivalentes, com alunos de diferentes faixas etárias, sempre monitorados.");

  tituloSecao(doc,"10. ATRASOS NA RETIRADA DO ALUNO");
  paragrafo(doc,"CLÁUSULA 8ª - A retirada do aluno deverá ocorrer até 18:40, horário máximo de funcionamento. Será concedida tolerância de 10 minutos. Após esse período, será cobrado R$ 75,00 por dia. Nos atrasos superiores a 30 minutos, será acrescido R$ 1,00 por minuto adicional.");

  tituloSecao(doc,"11. DA INADIMPLÊNCIA");
  paragrafo(doc,"CLÁUSULA 9ª - Em caso de atraso no pagamento, incidirão multa de 2%, juros de 1% ao mês e atualização monetária. A inadimplência superior a 30 dias poderá resultar em medidas administrativas e legais, conforme a legislação vigente.");

  tituloSecao(doc,"12. DA RESCISÃO");
  paragrafo(doc,"CLÁUSULA 10ª - O contrato poderá ser rescindido por qualquer das partes mediante aviso prévio de 30 dias, sendo devidos os valores correspondentes ao período.");

  tituloSecao(doc,"13. SAÚDE E SEGURANÇA");
  paragrafo(doc,"CLÁUSULA 11ª - O(s) CONTRATANTE(S) declara(m) que todas as informações de saúde da criança são verdadeiras e compromete(m)-se a comunicar qualquer alteração. Em caso de emergência, a CONTRATADA fica autorizada a encaminhar a criança ao atendimento médico mais próximo.");

  tituloSecao(doc,"14. USO DE IMAGEM");
  paragrafo(doc,"CLÁUSULA 12ª - O(s) CONTRATANTE(S) autoriza(m), gratuitamente, o uso da imagem da criança para fins institucionais e pedagógicos, salvo manifestação expressa em contrário apresentada por escrito.");

  tituloSecao(doc,"15. PROTEÇÃO DE DADOS");
  paragrafo(doc,"CLÁUSULA 13ª - A CONTRATADA compromete-se a cumprir a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018), utilizando os dados exclusivamente para finalidades educacionais, administrativas e legais relacionadas à prestação dos serviços.");

  tituloSecao(doc,"16. DISPOSIÇÕES GERAIS");
  paragrafo(doc,"CLÁUSULA 14ª - O(s) CONTRATANTE(S) declara(m) conhecer e aceitar o Regimento Escolar, o calendário e as normas internas da CONTRATADA.");

  tituloSecao(doc,"17. FORO");
  paragrafo(doc,"CLÁUSULA 15ª - Fica eleito o foro da Comarca de São Paulo/SP, com renúncia de qualquer outro, por mais privilegiado que seja.");
  paragrafo(doc,"E, por estarem justos e contratados, assinam o presente instrumento.");
  doc.moveDown(.5).font("Helvetica").fontSize(9).text(dataExtenso(x.ano_letivo),{align:"center"});
  doc.moveDown(3);
  const y=doc.y;
  doc.moveTo(60,y).lineTo(270,y).strokeColor("#333333").stroke();
  doc.moveTo(325,y).lineTo(535,y).stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#111111").text(`${ESCOLA.nome}\n${ESCOLA.representante}`,60,y+5,{width:210,align:"center"});
  doc.text(`${assinante?.nome||"Responsável contratante"}\nCPF: ${assinante?.cpf||""}`,325,y+5,{width:210,align:"center"});
  if(responsaveis.length>1){
    doc.moveDown(4);
    const y2=doc.y;
    doc.moveTo(193,y2).lineTo(403,y2).stroke();
    const outro=responsaveis.find(r=>r.id!==assinante?.id);
    doc.text(`${outro.nome}\nCPF: ${outro.cpf}`,193,y2+5,{width:210,align:"center"});
  }
  const paginas=doc.bufferedPageRange();
  for(let i=0;i<paginas.count;i++){
    doc.switchToPage(paginas.start+i);
    adicionarIdentidade(doc,x.numero,i+1);
  }
  doc.end();
});
app.post("/api/interessados/importar",auth,podeAtender,async(req,res)=>{
  const registros=Array.isArray(req.body?.registros)?req.body.registros:[];
  if(!registros.length)return res.status(400).json({erro:"A planilha não possui registros para importar."});
  if(registros.length>500)return res.status(400).json({erro:"Importe no máximo 500 interessados por vez."});
  const client=await db.connect(),resultado={importados:0,duplicados:0,invalidos:0,erros:[]},telefonesLote=new Set();
  try{
    await client.query("BEGIN");
    for(let i=0;i<registros.length;i++){
      const b=registros[i]||{},linha=i+2,responsavel=clean(b.responsavel_nome).slice(0,150),aluno=clean(b.aluno_nome).slice(0,150),telefone=clean(b.telefone).slice(0,30),digitos=somenteDigitos(telefone),email=clean(b.email).slice(0,180);
      if(!responsavel||!aluno||digitos.length<8){resultado.invalidos++;resultado.erros.push(`Linha ${linha}: informe responsável, aluno e um telefone válido.`);continue}
      if(email&&!/^\S+@\S+\.\S+$/.test(email)){resultado.invalidos++;resultado.erros.push(`Linha ${linha}: o e-mail não é válido.`);continue}
      const chave=aluno.toLowerCase()+"|"+digitos;
      const existente=telefonesLote.has(chave)||await client.query("SELECT id FROM interessados WHERE LOWER(aluno_nome)=LOWER($1) AND regexp_replace(telefone,'\\D','','g')=$2 LIMIT 1",[aluno,digitos]);
      if(telefonesLote.has(chave)||(existente.rows&&existente.rows[0])){resultado.duplicados++;continue}
      telefonesLote.add(chave);
      const origem=clean(b.origem).slice(0,40)||"outro",status=statusPermitidos.includes(clean(b.status))?clean(b.status):"novo";
      const proximoContato=/^\d{4}-\d{2}-\d{2}$/.test(String(b.proximo_contato||""))?b.proximo_contato:null;
      const entrada=/^\d{2}:\d{2}$/.test(String(b.entrada||""))?b.entrada:null,saida=/^\d{2}:\d{2}$/.test(String(b.saida||""))?b.saida:null;
      const inserido=await client.query(`INSERT INTO interessados(responsavel_nome,aluno_nome,telefone,email,origem,turma_interesse,plano_horas,entrada,saida,status,proximo_contato,observacoes,criado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[responsavel,aluno,telefone,email||null,origem,clean(b.turma_interesse).slice(0,60)||null,clean(b.plano_horas).slice(0,10)||null,entrada,saida,status,proximoContato,clean(b.observacoes).slice(0,5000)||null,req.session.user.id]);
      await client.query("INSERT INTO historico(tipo_entidade,entidade_id,acao,detalhes,usuario_id) VALUES('interessado',$1,'cadastro_importado',$2,$3)",[inserido.rows[0].id,`Aluno: ${aluno} | Responsável: ${responsavel} | Importado por planilha`,req.session.user.id]);
      resultado.importados++;
    }
    await client.query("COMMIT");
    res.status(201).json(resultado);
  }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Falha na importação de interessados:",e);
    res.status(400).json({erro:"Não foi possível importar a planilha. Nenhum registro deste envio foi salvo."});
  }finally{client.release()}
});
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(root,"../public/index.html")));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({erro:"Erro interno. Tente novamente."});});
app.listen(Number(process.env.PORT)||3000,process.env.HOST||"0.0.0.0",()=>{const porta=Number(process.env.PORT)||3000;console.log(`CRM Gestão Escolar - versão ${versaoSistema}`);console.log(`CRM disponível neste computador: http://localhost:${porta}`);for(const ip of enderecosIPv4Rede())console.log(`CRM disponível na rede: http://${ip}:${porta}`);iniciarBackupAutomatico()});

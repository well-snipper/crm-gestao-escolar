@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Instalacao do Servidor - CRM Gestão Escolar

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Solicitando permissao de administrador...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo CRM Gestão Escolar - INSTALACAO DO SERVIDOR
echo ==========================================
echo.

where node.exe >nul 2>&1
if not "%errorlevel%"=="0" (
  echo ERRO: Node.js nao foi encontrado.
  echo Instale o Node.js 22 LTS e execute este instalador novamente.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if not "%errorlevel%"=="0" (
  echo ERRO: npm.cmd nao foi encontrado.
  echo Reinicie o Windows depois de instalar o Node.js e tente novamente.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo O arquivo .env foi criado.
  echo.
  echo O Bloco de Notas sera aberto agora.
  echo Informe a senha do PostgreSQL em DATABASE_URL e troque SESSION_SECRET.
  echo Salve e feche o arquivo para continuar.
  start /wait notepad.exe ".env"
)

echo.
echo Instalando os componentes do CRM...
call npm.cmd install --omit=dev
if not "%errorlevel%"=="0" (
  echo.
  echo ERRO: Nao foi possivel instalar os componentes.
  echo Verifique a internet e tente novamente.
  pause
  exit /b 1
)

echo.
echo Preparando o banco de dados...
call npm.cmd run db:init
if not "%errorlevel%"=="0" (
  echo.
  echo ERRO: Nao foi possivel preparar o banco.
  echo Confirme se o PostgreSQL esta ligado, se o banco crm_gestao_escolar existe
  echo e se a senha informada no arquivo .env esta correta.
  pause
  exit /b 1
)

echo.
echo Liberando o acesso somente pela rede privada do Windows...
netsh advfirewall firewall delete rule name="CRM Gestão Escolar - Rede local" >nul 2>&1
netsh advfirewall firewall add rule name="CRM Gestão Escolar - Rede local" dir=in action=allow protocol=TCP localport=3000 profile=private >nul
if not "%errorlevel%"=="0" (
  echo AVISO: A regra do Firewall nao foi criada.
  echo Consulte o manual para fazer a liberacao manualmente.
)

echo.
echo Criando os atalhos...
cscript.exe //nologo "Instalar_Atalhos_Servidor.vbs"

(
  echo DADOS DO SERVIDOR - CRM Gestão Escolar
  echo =====================================
  echo Nome do computador: %COMPUTERNAME%
  echo Porta do CRM: 3000
  echo.
  echo Enderecos IPv4 encontrados:
  ipconfig ^| findstr /I /C:"IPv4"
  echo.
  echo Use primeiro o nome %COMPUTERNAME% no instalador das estacoes.
  echo Se o nome nao funcionar, use o IPv4 da placa conectada a rede do Colegio.
) > "DADOS_DO_SERVIDOR.txt"

echo.
echo Instalacao concluida.
echo Os dados para configurar as estacoes estao em DADOS_DO_SERVIDOR.txt.
echo Abra o CRM pelo atalho da Area de Trabalho.
echo.
pause
endlocal


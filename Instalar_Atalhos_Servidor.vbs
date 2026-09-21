Option Explicit

Dim shell, fso, pasta, desktop, programas, inicializar, atalho
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")
programas = shell.SpecialFolders("Programs")
inicializar = shell.SpecialFolders("Startup")

Set atalho = shell.CreateShortcut(desktop & "\CRM Gestão Escolar.lnk")
ConfigurarAtalhoAplicativo atalho
atalho.Save

Set atalho = shell.CreateShortcut(programas & "\CRM Gestão Escolar.lnk")
ConfigurarAtalhoAplicativo atalho
atalho.Save

Set atalho = shell.CreateShortcut(inicializar & "\CRM Gestão Escolar - Servidor.lnk")
atalho.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
atalho.Arguments = Chr(34) & pasta & "\Iniciar_Servidor_CRM.vbs" & Chr(34)
atalho.WorkingDirectory = pasta
atalho.IconLocation = pasta & "\public\assets\logo-colegio-horizonte.ico,0"
atalho.Description = "Iniciar o servidor do CRM Gestão Escolar"
atalho.WindowStyle = 1
atalho.Save

MsgBox "Atalhos instalados. O servidor do CRM tambem iniciara automaticamente ao entrar no Windows.", 64, "CRM Gestão Escolar"

Sub ConfigurarAtalhoAplicativo(item)
  item.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
  item.Arguments = Chr(34) & pasta & "\Abrir_crm_gestao_escolar.vbs" & Chr(34)
  item.WorkingDirectory = pasta
  item.IconLocation = pasta & "\public\assets\logo-colegio-horizonte.ico,0"
  item.Description = "Abrir o CRM do Colegio Cristao Horizonte"
  item.WindowStyle = 1
End Sub


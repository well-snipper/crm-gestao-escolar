Option Explicit

Dim shell, fso, pasta, url, edge, comando, retorno
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:3000"

retorno = shell.Run("wscript.exe " & Chr(34) & pasta & "\Iniciar_Servidor_CRM.vbs" & Chr(34), 0, True)
If retorno <> 0 Then
  MsgBox "Nao foi possivel iniciar o CRM. Verifique o arquivo logs\crm.log.", 16, "CRM Gestão Escolar"
  WScript.Quit 1
End If

edge = LocalizarNavegador()
If edge <> "" Then
  comando = Chr(34) & edge & Chr(34) & " --app=" & Chr(34) & url & Chr(34) & " --start-maximized"
  shell.Run comando, 1, False
Else
  shell.Run url, 1, False
End If

Function LocalizarNavegador()
  Dim caminho
  caminho = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
  If fso.FileExists(caminho) Then
    LocalizarNavegador = caminho
    Exit Function
  End If

  caminho = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
  If fso.FileExists(caminho) Then
    LocalizarNavegador = caminho
    Exit Function
  End If

  caminho = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
  If fso.FileExists(caminho) Then
    LocalizarNavegador = caminho
    Exit Function
  End If

  caminho = shell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe"
  If fso.FileExists(caminho) Then
    LocalizarNavegador = caminho
    Exit Function
  End If

  LocalizarNavegador = ""
End Function


Option Explicit

Dim shell, fso, pasta, url, comando, tentativas
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:3000"

If ServidorAtivo(url) Then
  WScript.Quit 0
End If

If Not fso.FolderExists(pasta & "\logs") Then
  fso.CreateFolder pasta & "\logs"
End If

comando = "cmd.exe /c cd /d " & Chr(34) & pasta & Chr(34) & " && npm.cmd start >> " & Chr(34) & pasta & "\logs\crm.log" & Chr(34) & " 2>&1"
shell.Run comando, 0, False

tentativas = 0
Do While Not ServidorAtivo(url) And tentativas < 120
  WScript.Sleep 500
  tentativas = tentativas + 1
Loop

If ServidorAtivo(url) Then
  WScript.Quit 0
End If

WScript.Quit 1

Function ServidorAtivo(endereco)
  Dim http, status
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  End If
  http.Open "GET", endereco & "/", False
  http.SetTimeouts 1000, 1000, 1000, 2000
  http.setRequestHeader "Cache-Control", "no-cache"
  http.Send
  status = 0
  status = http.Status
  ServidorAtivo = (Err.Number = 0 And status >= 200 And status < 500)
  Err.Clear
  Set http = Nothing
  On Error GoTo 0
End Function


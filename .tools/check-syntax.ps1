$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('c:\Users\akasa\Desktop\MYPROJECTS\ai\qwen-gate\qwen-control.ps1', [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output 'SYNTAX OK' } else { $errors | ForEach-Object { Write-Output $_.Message } }

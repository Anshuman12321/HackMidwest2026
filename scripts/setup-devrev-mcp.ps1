param(
    [string]$Url,
    [switch]$Clipboard,
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.codex\config.toml')
)

$ErrorActionPreference = 'Stop'
$text = if (Test-Path -LiteralPath $ConfigPath) {
    [System.IO.File]::ReadAllText($ConfigPath)
} else { '' }
$pattern = '(?ms)^\[mcp_servers\.DevRev\][ \t]*\r?\n.*?(?=^\[|\z)'
$matchesFound = [regex]::Matches($text, $pattern)
if ($matchesFound.Count -gt 1) { throw 'Duplicate DevRev sections; no changes made.' }
$section = if ($matchesFound.Count) { $matchesFound[0].Value } else { "[mcp_servers.DevRev]`n" }
# Refuse nested header tables rather than risk leaving conflicting credentials.
if ($text -match '(?m)^\[mcp_servers\.DevRev\.(http_headers|env_http_headers)\]') {
    throw 'Nested DevRev header tables found; convert them to inline tables first. No changes made.'
}
if (-not $Url -and $section -notmatch '(?m)^url\s*=') {
    $Url = Read-Host 'DevRev MCP server URL (use the URL from your teammate)'
}
if ($Url) {
    $uri = $null
    if (-not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) {
        throw 'Provide an HTTPS server URL without embedded credentials. No changes made.'
    }
    $section = [regex]::Replace($section, '(?m)^url\s*=.*\r?\n?', '')
    $section = $section.TrimEnd() + "`nurl = " + (ConvertTo-Json -InputObject $Url -Compress) + "`n"
}
$secureToken = $null
$token = $null
$temporaryPath = $null
try {
    if ($Clipboard) {
        $token = (Get-Clipboard -Raw).Trim()
    } else {
        $secureToken = Read-Host 'DevRev PAT (hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    if (-not $token -or $token -match '\s|[\x00-\x1f\x7f]') {
        throw 'PAT is empty or contains whitespace/control characters. No changes made.'
    }
    $section = [regex]::Replace($section, '(?m)^(?:bearer_token_env_var|http_headers|env_http_headers)\s*=.*\r?\n?', '')
    $section = $section.TrimEnd() + "`nhttp_headers = { Authorization = " + (ConvertTo-Json -InputObject ('Bearer ' + $token) -Compress) + " }`n`n"
    $updated = if ($matchesFound.Count) {
        $match = $matchesFound[0]
        $text.Substring(0, $match.Index) + $section + $text.Substring($match.Index + $match.Length)
    } else { $text.TrimEnd() + "`n`n" + $section }
    $directory = Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporaryPath = Join-Path $directory ([IO.Path]::GetRandomFileName())
    # Apply a private ACL before writing the token (Windows equivalent of chmod 600).
    [IO.File]::WriteAllText($temporaryPath, '')
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($identity)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temporaryPath -AclObject $acl
    [IO.File]::WriteAllText($temporaryPath, $updated, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $ConfigPath) {
        # File.Replace may retain the destination ACL, so secure it first too.
        Set-Acl -LiteralPath $ConfigPath -AclObject $acl
        # Windows PowerShell coerces $null to an empty string for this overload.
        [IO.File]::Replace($temporaryPath, $ConfigPath, [System.Management.Automation.Language.NullString]::Value)
    } else { [IO.File]::Move($temporaryPath, $ConfigPath) }
    $temporaryPath = $null
    Write-Host 'Saved DevRev authentication. The PAT was not printed. Restart Codex to load the server.'
} finally {
    $token = $null
    $updated = $null
    $section = $null
    if ($secureToken) { $secureToken.Dispose() }
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

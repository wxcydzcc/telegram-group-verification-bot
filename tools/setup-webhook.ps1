$ErrorActionPreference = 'Stop'

$workerUrl = (Read-Host '请输入群验证Worker地址，例如 https://telegram-group-verification-bot.xxx.workers.dev').TrimEnd('/')
$webhookSecret = Read-Host '请输入Cloudflare中设置的WEBHOOK_SECRET'
$secureToken = Read-Host '请输入群验证机器人Token（输入内容不会显示）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $payload = @{
        url = "$workerUrl/webhook"
        secret_token = $webhookSecret
        allowed_updates = @('message', 'callback_query', 'chat_member')
        drop_pending_updates = $false
    } | ConvertTo-Json

    $result = Invoke-RestMethod -Method Post `
        -Uri "https://api.telegram.org/bot$token/setWebhook" `
        -ContentType 'application/json' -Body $payload

    $commands = @{
        commands = @(
            @{ command = 'start'; description = '查看机器人说明' },
            @{ command = 'chatid'; description = '管理员查看群组数字ID' },
            @{ command = 'verify_stats'; description = '查看等待验证人数' }
        )
    } | ConvertTo-Json -Depth 5
    $null = Invoke-RestMethod -Method Post `
        -Uri "https://api.telegram.org/bot$token/setMyCommands" `
        -ContentType 'application/json' -Body $commands

    $info = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$token/getWebhookInfo"
    $result
    $info.result | Select-Object url, pending_update_count, last_error_message | Format-List
}
finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    Remove-Variable token -ErrorAction SilentlyContinue
}

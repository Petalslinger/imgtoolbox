# ============================================================
#  upload-to-github.ps1
#
#  把 imgtoolbox 提交并推送到 https://github.com/Petalslinger/imgtoolbox
#
#  我（AI）在这个环境里执行不了任何命令，所以这个脚本得由你来跑。
#
#  跑法（二选一）：
#    · 右键这个文件 → 「使用 PowerShell 运行」
#    · 或者打开 PowerShell，粘贴：
#        powershell -ExecutionPolicy Bypass -File D:\dsh\imgtoolbox\tools\upload-to-github.ps1
#
#  脚本会在提交之前停下来让你确认，不会不看一眼就推上去。
# ============================================================

$ErrorActionPreference = 'Stop'

$Remote = 'https://github.com/Petalslinger/imgtoolbox.git'
$RepoDir = Split-Path -Parent $PSScriptRoot      # tools 的上一层，也就是项目根

# 中文注释和中文提交信息都要按 UTF-8 处理，否则 git 里会出现乱码
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Step($n, $text) {
    Write-Host ''
    Write-Host "[$n] $text" -ForegroundColor Cyan
}

function Fail($text) {
    Write-Host ''
    Write-Host "✗ $text" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== imgtoolbox → GitHub ===' -ForegroundColor Green
Write-Host "项目目录：$RepoDir"
Write-Host "远程仓库：$Remote"

# ── 0. 检查 git 在不在 ───────────────────────────────────
Step 0 '检查 git 是否可用'
try {
    $ver = (git --version) 2>&1
    Write-Host "  $ver"
} catch {
    Fail '找不到 git。请先安装：https://git-scm.com/download/win'
}

Set-Location $RepoDir

# ── 1. 清理废弃的占位文件 ────────────────────────────────
Step 1 '清理废弃文件（旧流水线设计的遗留空壳）'
$junk = @('js\steps.js', 'js\preview.js', '.probe', 'tools\make-selftest.js')
foreach ($f in $junk) {
    if (Test-Path $f) {
        Remove-Item $f -Force
        Write-Host "  已删除 $f" -ForegroundColor DarkGray
    }
}
Write-Host '  清理完成。'

# ── 2. 初始化仓库 ────────────────────────────────────────
Step 2 '初始化 git 仓库'
if (Test-Path '.git') {
    Write-Host '  已经是个仓库了，跳过 git init。' -ForegroundColor DarkGray
} else {
    git init | Out-Host
}

# ── 3. 检查提交身份 ──────────────────────────────────────
Step 3 '检查提交身份'
$name = (git config user.name) 2>$null
$mail = (git config user.email) 2>$null

if (-not $name -or -not $mail) {
    Write-Host '  git 还不知道你是谁，需要设一次（只需一次，之后全局生效）。' -ForegroundColor Yellow
    $name = Read-Host '  你的名字（或 GitHub 昵称）'
    $mail = Read-Host '  你的邮箱'
    if (-not $name -or -not $mail) { Fail '名字和邮箱都不能为空。' }
    git config --global user.name $name
    git config --global user.email $mail
    Write-Host "  已设置：$name <$mail>" -ForegroundColor Green
} else {
    Write-Host "  $name <$mail>"
}

# ── 4. 暂存 ──────────────────────────────────────────────
Step 4 '暂存所有文件'
git add -A | Out-Host

# ── 5. 让你确认到底要提交什么 ────────────────────────────
Step 5 '请检查下面这份清单'
Write-Host ''
git status --short | Out-Host
Write-Host ''
Write-Host '  预期应该只有这些：' -ForegroundColor DarkGray
Write-Host '    .gitignore / LICENSE / README.md / PUBLISH.md' -ForegroundColor DarkGray
Write-Host '    index.html / selftest.html / css/style.css' -ForegroundColor DarkGray
Write-Host '    js/*.js（13 个模块）/ tools/upload-to-github.ps1' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  注意：' -ForegroundColor Yellow
Write-Host '    · 不该出现 node_modules、测试图片、build 产物' -ForegroundColor Yellow
Write-Host '    · 这份清单会公开到 GitHub 上' -ForegroundColor Yellow
Write-Host ''
$answer = Read-Host '  确认提交并推送吗？(y/N)'
if ($answer -notmatch '^[Yy]') {
    Write-Host ''
    Write-Host '已取消。文件已经暂存好了，你随时可以自己 git commit / git push。' -ForegroundColor Yellow
    exit 0
}

# ── 6. 提交 ──────────────────────────────────────────────
Step 6 '提交'
$subject = '图片工具箱：四个独立分区（重命名 / 改分辨率 / 转格式 / 导出 PDF）'
$body = @'
纯前端、零依赖、零构建：双击 index.html 就能用，图片不上传。

- 四个分区互不干扰，共用左栏文件池（顺序即导出顺序）
- 自研 PDF 写出器：统一重编码为基线 JPEG 内嵌，写出后自检
  （逐字段解析 xref、核对对象偏移、验证流完整性），验不过就报错
- 自研 ZIP 写出器：CRC-32 + CompressionStream deflate，UTF-8 文件名
- 像素处理在 Web Worker 里跑，实现只有一份（源码字符串注入 worker）
- selftest.html：浏览器里跑 11 组断言，含 pdf.js 交叉验证
- 沿用原 png2pdf 的行为：数字感知排序、透明垫白底、1px = 1pt
'@

git commit -m $subject -m $body | Out-Host

# ── 7. 分支名统一成 main ─────────────────────────────────
Step 7 '把分支名统一成 main'
git branch -M main | Out-Host

# ── 8. 配置远程 ──────────────────────────────────────────
Step 8 '配置远程仓库'
# 用 set-url --add：远程不存在时新建，已存在时追加，两种情况都不会报错
git remote set-url --add origin $Remote | Out-Host
git remote -v | Out-Host

# ── 9. 推送 ──────────────────────────────────────────────
Step 9 '推送到 GitHub（第一次会弹浏览器让你登录授权）'
git push -u origin main
$pushCode = $LASTEXITCODE

Write-Host ''
if ($pushCode -eq 0) {
    Write-Host '=== 成功 ===' -ForegroundColor Green
    Write-Host "打开看看：https://github.com/Petalslinger/imgtoolbox"
} else {
    Write-Host '=== 推送失败 ===' -ForegroundColor Red
    Write-Host ''
    Write-Host '常见原因和处理：' -ForegroundColor Yellow
    Write-Host '  · 远程已经有 main 分支（建仓库时勾了 README）：'
    Write-Host '      git pull --rebase origin main'
    Write-Host '      git push -u origin main'
    Write-Host '  · 认证失败：检查 GitHub 凭据，或改用 SSH 地址'
    Write-Host '  · 网络问题：确认能访问 github.com'
    Write-Host ''
    Write-Host '把上面的报错原文发给我，我帮你看。'
}

Write-Host ''
Read-Host '按回车关闭'

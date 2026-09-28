# 上传到 GitHub

目标仓库：**https://github.com/Petalslinger/imgtoolbox**

这个项目已经在 `imgtoolbox/` 目录里准备好了（`LICENSE`、`.gitignore` 都有）。
下面命令**全部在 `D:\dsh\imgtoolbox` 目录里执行**。

> 我（AI）执行不了命令，所以最后这几步得你自己跑。复制粘贴即可。

---

## 第一步：确认远程仓库是空的

打开 https://github.com/Petalslinger/imgtoolbox

- 如果页面显示 **"Quick setup — if you've done this kind of thing before"**，说明是空仓库，可以直接进第二步
- 如果里面已经有 `README.md` 之类的文件，那就**不要**用下面的 `git init` 流程，
  改成先 `git clone https://github.com/Petalslinger/imgtoolbox.git`，
  再把文件拷进去提交

---

## 第二步：本地提交

打开 PowerShell 或 Git Bash，粘贴：

```powershell
cd D:\dsh\imgtoolbox

# 如果这个目录还没被别的仓库管着，就先初始化
git init

# 如果 D:\dsh 本身已经是个 git 仓库，imgtoolbox 就会跟着它走，
# 那种情况下上面那行会提示 "Reinitialized existing Git repository"，
# 属于正常，继续往下走即可。

git add -A
git status
```

`git status` 是让你**先看一眼要提交什么**。确认列表里是这些文件：

```
.gitignore
LICENSE
README.md
PUBLISH.md
index.html
selftest.html
css/style.css
js/*.js          （13 个模块）
tools/README.txt
```

**如果里面出现了你不想公开的东西**（比如测试用的图片、`node_modules`），
先 `git rm --cached 那个文件` 或者补进 `.gitignore`，再继续。

确认没问题后提交：

```powershell
git commit -m "图片工具箱：四个独立分区（重命名 / 改分辨率 / 转格式 / 导出 PDF）" -m "纯前端、零依赖、零构建：双击 index.html 就能用，图片不上传。

- 四个分区互不干扰，共用左栏文件池（顺序即导出顺序）
- 自研 PDF 写出器：统一重编码为基线 JPEG 内嵌，写出后自检
  （逐字段解析 xref、核对对象偏移、验证流完整性），验不过就报错
- 自研 ZIP 写出器：CRC-32 + CompressionStream deflate，UTF-8 文件名
- 像素处理在 Web Worker 里跑，实现只有一份（源码字符串注入 worker）
- selftest.html：浏览器里跑 11 组断言，含 pdf.js 交叉验证
- 沿用原 png2pdf 的行为：数字感知排序、透明垫白底、1px = 1pt"
```

---

## 第三步：设分支名并推上去

GitHub 现在默认分支叫 `main`，老版本 git 默认叫 `master`，直接统一成 `main`：

```powershell
git branch -M main
git remote add origin https://github.com/Petalslinger/imgtoolbox.git
git push -u origin main
```

第一次推送会弹出浏览器让你登录授权，跟着走就行。

---

## 如果 git 提示 "remote origin already exists"

说明 `D:\dsh` 那个仓库已经有 origin 了。改成换地址：

```powershell
git remote set-url origin https://github.com/Petalslinger/imgtoolbox.git
git push -u origin main
```

---

## 如果 D:\dsh 本身是个仓库，而你只想传这一个子目录

那就别在 `imgtoolbox` 里 `git init`，改成用 `git subtree`，或者干脆
把 `imgtoolbox` 目录**复制到仓库外面**（比如 `D:\projects\imgtoolbox`），
在那里重新 `git init`，这样最干净。

---

## 顺带：仓库设置建议

推上去之后可以在仓库页面做两件小事：

1. **About 里勾 Topics**：`image-processing` `batch-rename` `pdf` `browser`
   `no-dependencies` `offline` `canvas`
2. **About 里填 Website**：如果开了 GitHub Pages，可以指向 `index.html`——
   不过要注意：如果开 Pages，浏览器会用 `https://` 加载，此时 `file://` 下
   被 CORS 拦掉的 `fetch` 反而能用了（`selftest.html` 的第二组会从"跳过"变成真检查）

---

## 别忘了

`js/steps.js` 和 `js/preview.js` 已经是废弃的空壳（旧流水线设计的遗留），
我在这台机器上删不掉文件，你可以直接删：

```powershell
Remove-Item js\steps.js, js\preview.js, .probe, tools\make-selftest.js
git add -A
git commit -m "删掉旧流水线设计的遗留空壳"
```

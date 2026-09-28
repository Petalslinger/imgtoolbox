# 上传到 GitHub

目标仓库：**https://github.com/Petalslinger/imgtoolbox**

本项目已在当前目录准备就绪（`LICENSE`、`.gitignore` 均已包含）。
以下命令**全部在项目根目录（即放置 `index.html` 的那一层）执行**。

> 这些命令需由使用者在本机执行，直接复制粘贴即可。

---

## 第一步：确认远程仓库是空的

打开 https://github.com/Petalslinger/imgtoolbox

- 如果页面显示 **"Quick setup — if you've done this kind of thing before"**，说明是空仓库，可直接进入第二步
- 如果里面已经有 `README.md` 之类的文件，那就**不要**使用下面的 `git init` 流程，
  应先执行 `git clone https://github.com/Petalslinger/imgtoolbox.git`，
  再把文件复制进去提交

---

## 第二步：本地提交

打开 PowerShell 或 Git Bash，粘贴：

```powershell
cd <项目根目录>

# 如果这个目录还没被别的仓库管着，就先初始化
git init

# 如果上一级目录本身已经是个 git 仓库，这里会跟着它走，
# 那种情况下上面那行会提示 "Reinitialized existing Git repository"，
# 属于正常，继续往下走即可。

git add -A
git status
```

`git status` 用于**确认待提交内容**。确认列表中包含这些文件：

```
.gitignore
LICENSE
README.md
PUBLISH.md
index.html
selftest.html
css/style.css
js/*.js          （13 个模块）
```

**如果列表中出现了不宜公开的内容**（比如测试用的图片、`node_modules`），
先执行 `git rm --cached 那个文件` 或将其补进 `.gitignore`，再继续。

确认无误后提交：

```powershell
git commit -m "图片工具箱：四个独立分区（重命名 / 改分辨率 / 转格式 / 导出 PDF）" -m "纯前端、零依赖、零构建：双击 index.html 即可使用，图片不上传。

- 四个分区相互独立，共用文件池（顺序即导出顺序）
- 本仓库实现的 PDF 写出器：统一重编码为基线 JPEG 内嵌，生成后执行结构自检
  （解析 xref、核对对象偏移、校验流边界与 JPEG 完整性），校验不通过即报错
- 本仓库实现的 ZIP 写出器：CRC-32 + CompressionStream deflate，UTF-8 文件名
- 像素处理在 Web Worker 中执行，实现仅一份（以源码字符串注入 Worker），
  注入清单带静态检查，回退主线程时在控制台给出说明
- 导出 PDF 支持统一页面宽度：按最宽一张等比缩放，各页等宽且不变形
- selftest.html：浏览器中执行十余组断言，含 pdf.js 独立实现交叉验证
- 沿用原 png2pdf 的行为：数字感知排序、透明区填充白底、1px = 1pt"
```

---

## 第三步：设分支名并推上去

GitHub 当前默认分支为 `main`，旧版本 git 默认为 `master`，此处统一为 `main`：

```powershell
git branch -M main
git remote add origin https://github.com/Petalslinger/imgtoolbox.git
git push -u origin main
```

首次推送会弹出浏览器进行登录授权，按提示完成即可。

---

## 如果 git 提示 "remote origin already exists"

说明 `D:\dsh` 仓库已经配置了 origin。此时改用更换地址的方式：

```powershell
git remote set-url origin https://github.com/Petalslinger/imgtoolbox.git
git push -u origin main
```

---

## 上一级目录本身是仓库、而只需提交该子目录时

此时不应在此处执行 `git init`，可改用 `git subtree`；或将整个项目目录
**复制到仓库之外**，在其副本中重新执行 `git init`，该方式最为清晰。

---

## 仓库设置建议

推送完成后，可在仓库页面进行以下两项设置：

1. **在 About 中设置 Topics**：`image-processing` `batch-rename` `pdf` `browser`
   `no-dependencies` `offline` `canvas`
2. **在 About 中填写 Website**：如果启用了 GitHub Pages，可以指向 `index.html`。
   需要注意：启用 Pages 后，浏览器会用 `https://` 加载，此时在 `file://` 下
   被 CORS 阻止的 `fetch` 反而可用（`selftest.html` 的第二组会从"跳过"变为实际检查）

---

## 待手动删除的遗留文件

`js/steps.js` 和 `js/preview.js`（旧「可编排队列」设计的空壳）现在只剩一段
说明，**文件本身仍存在于磁盘上**——本机环境无法删除文件。执行：

```powershell
Remove-Item js\steps.js, js\preview.js
git add -A
git commit -m "删掉旧流水线设计的遗留空壳"
```

`tools\` 目录（其中只有一份说明自身可以删除的 `README.txt` 和一个未被采用的
生成脚本）同理，整体删除即可。

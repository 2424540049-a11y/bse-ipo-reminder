# 北交所网上申购提醒

用于查看北交所新股**网上申购日期、上市日期及卖出关注事项**的轻量工作台。支持手机安装到主屏幕、离线查看、手工日程及本机处理标记。

**在线入口：[打开北交所日程](https://2424540049-a11y.github.io/bse-ipo-reminder/)**

## 安装到手机

- **iPhone**：用 Safari 打开在线入口 → 分享 → 添加到主屏幕；如出现“作为网页 App 打开”，保持开启。
- **Android**：用 Chrome 打开 → 点击页面“安装到手机”，或浏览器菜单中的“安装应用／添加到主屏幕”。
- 安装后可从主屏幕独立打开。首次需联网加载，之后可离线查看最近一次缓存。
- 提醒只在页面中展示；没有后台推送。手机使用不依赖电脑开机。

## 功能

- 今日申购、未来 7 天申购、上市／卖出关注、上市待公告。
- 统一北京时间，区分申购未开始、申购时段、午间休市和当日结束。
- 未公布的上市日期保留为空，不按 T+N 推算。
- 搜索股票、筛选日期、标记已处理、补充或修正日程。
- 浏览器内 CSV 导入导出，支持中文、Excel UTF-8 BOM 和输入校验。
- 手工记录、处理标记及缓存保存在当前设备浏览器中；不同设备不自动同步。
- 演示模式与真实记录隔离。清除浏览器网站数据会删除本机标记，重要记录请导出备份。

“上市／卖出关注”仅提示上市日程。工具不接入持仓或交易系统，不代表实际持有该股或要求上市当天卖出。

## 数据更新

公开日程来自[东方财富北交所新股表](https://data.eastmoney.com/xg/xg/?mkt=bjs)，按 `.BJ` 市场标识及网上发行数量筛选；网页保留近 120 天、未来及日期待确认记录。

GitHub Actions 在北京时间**周一至周五 08:17—16:47，每半小时**尝试更新并发布。页面每 30 分钟同步已发布快照，也可手动点“同步日程”。GitHub 调度可能延迟，聚合源也可能晚于交易所公告，因此应查看页面的**公开数据更新时间**并核对公告。

数据更新失败时，保留最近成功记录和原更新时间，并展示失败信息；首次没有有效缓存时停止发布。周末、节假日不是按交易日自动判定。公开仓库长期无活动时，GitHub 可能停用计划工作流，可在 Actions 中检查并重新启用。

每只股票的申购代码、资金要求、申购上限及上市安排以正式发行／上市公告为准。项目仅覆盖北交所股票网上发行，不含网下询价、战略配售或 REITs。

## 技术结构

| 文件 | 用途 |
| --- | --- |
| `docs/` | GitHub Pages 静态手机应用、安装清单与离线缓存 |
| `docs/platform.js` | 本机状态、输入校验、CSV、快照同步 |
| `market_data.py` | 东方财富北交所网上发行数据读取与校验 |
| `scripts/build_web_data.py` | 构建仅含公开字段的日程快照 |
| `.github/workflows/pages.yml` | 测试、定时更新、发布 GitHub Pages |
| `app.py` / `static/` | 保留的 Python 本地版 |
| `tests/` | Python 与 Node.js 数据逻辑测试 |

代码实现过程中使用了 AI 辅助。项目没有账户口令、个人简历或真实持仓数据；手机端手工操作不写回 GitHub。

## 本地预览与测试

Python 3.9+、Node.js 18+，测试无需第三方依赖：

```sh
python3 scripts/build_web_data.py
python3 -m unittest discover -s tests -v
node --test tests/test_platform.cjs
python3 -m http.server 8893 --bind 127.0.0.1
```

然后打开 `http://127.0.0.1:8893/docs/`。原 Python 本地版可运行 `python3 app.py`，详见 [本地版说明](LOCAL_README.md)。

## 重新发布

仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。推送 `main` 或在 Actions 手动运行 **Publish mobile dashboard** 即可发布；工作流只需仓库读取和 Pages 发布权限。

参考：[GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[iPhone 主屏幕网页应用](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)。

# 开发与验证
原生 JavaScript / HTML / CSS，无构建框架。安装直接加载仓库根目录。Node.js 下运行 npm test：6项合成数据回归，无付费模型调用。
内部1.0基线46项自动检查通过，不代表46项真实猎聘验收。详见 ACCEPTANCE.md。
agent-page.js/content.js：抓取；agent-tasks.js：后台任务与保存；agent-core.js：状态规则；workflow.js：内容流程；app.js/agent-ui.js：界面；onboarding.js：引导；sync-data.js：同步字段。
测试数据与截图均不应使用真实聊天或密钥。发布前核对许可、第三方署名、安装目录兼容和实际验收边界。

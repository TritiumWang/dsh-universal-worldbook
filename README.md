# dsh-universal-worldbook / 通用世界书

DSH通用世界书/临时提示词注入器：

关键字 / 正则 / 常驻触发的提示词片段，经 `llm/stream` 请求级改写临时注入到任意会话场景（角色扮演、编程、科研…），永不写入会话历史。

主体思路仍然是酒馆式的提示词预组装+上下文隔离，但增加了检索功能，允许agent自主查阅世界书条目，查询到的内容同样仅在本轮生效，不会在后续对话的context中出现。

尽量保证了UI简洁，理解成本最低：世界书按工作区决定哪些生效，条目布局基本还原酒馆风格，额外加了拖动排序和命中条目预览功能

插入位置恒定为D0前部（拼接在用户最新消息之前，身份为user），缓存在D2之前全部命中，不在整个消息头部插入（会导致缓存全部破坏）。

独立小功能，尽量与其他功能解耦，数据兼容酒馆世界书。


## 特性

- **请求级注入,避免上下文污染**:注入只存在于出站请求副本(`llm/stream` 重写 + WeakSet 防环),绝不 append 到 Session,轨迹中不可见,旧注入不进后续轮上下文。
- **匹配**:常驻(constant)与关键词(key,支持 `/regex/`),语料按扫描深度 D0..D(depth-1)(深度可调,1~5,默认 3);ST 同款过滤器逻辑(与所有/与任意/非所有/非任何,主关键词之间恒为或逻辑)。
- **`lore_lookup` 工具**:主 agent 可调用(agent 作用域注册,子代理默认不可见),按需取"索引式"条目的详情;查询结果**逐轮剥离**(D0 前的 tool-call/tool-result 从请求剔除),战斗等长场景靠子条目关键词自动续供,零重复查询;同轮防重复护栏。
- **D1 回合追踪器**:以 `session/event` 锚定"上一回合最终正文"。
- **UI(独立窗口)**:世界书/条目 CRUD、JSON 导入导出、作用域开关、世界书条目复原酒馆风格UI、整卡/整行拖拽排序、自动保存(切换/关闭落盘)、通用头/尾提示词块、扫描深度滑块 + 命中预览(基于会话真实消息实时计算)。
- **数据**:`DSH_HOME/WorldBook/`,酒馆世界书兼容的 JSON 无损读写(一些过于冗杂的ST世界书功能未开发，未知字段保留),数据与插件代码分离,升级不丢。

## 安装
网页版：
```dsh plugin --profile web add github:TritiumWang/dsh-universal-worldbook```


桌面版：
```dsh plugin --profile desktop add github:TritiumWang/dsh-universal-worldbook```

## 数据与作用域

- 世界书文件:`DSH_HOME/WorldBook/worldbooks/<id>.json`(ST 兼容:`{ "entries": { "0": {...} } }`)
- 启用表:`enabled.json`(`global[]` ∪ `workspace[<cwdKey>]`;preset 层不做,见设计决策)
- 顺序:`index.json`;通用头/尾:`format.json`;行为设置:`settings.json`(scanDepth / hitPreview)
- `lore_lookup` 只查**当前作用域已启用**条目,与注入同源。

## 诊断功能(发布态默认全关)

| 环境变量 | 作用 |
|---|---|
| `DSH_UWB_TRACE=1` | 落盘每次主请求的出站上下文全文快照(含注入/剥离改写版)到 `WorldBook/.trace/<sessionId>.jsonl` |
| `DSH_UWB_JOURNAL=1` | 落盘注入台账(命中明细)到 `WorldBook/.injections/<sessionId>.jsonl`(24h 自清) |
| `DSH_UWB_DEBUG=1` | `.uwb-debug.log` 追加 INFO 级(注册自检/D1 锚定等);错误/警告始终记录 |

相关代码以环境变量门控关闭, debug / 后续开发备用。


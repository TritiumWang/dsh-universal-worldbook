// client.js — dsh-universal-worldbook 浏览器半区(lazy-CJS bundle,M3 编辑器版 v4)。
// 经 package.json 的 dsh.client + exports["./client"] 被 dsh-client-modules 扫描并注入浏览器模块表;
// 数据 = host webServer 路由 /uwb-api/* 同源 fetch(见策划案 §13.10/13.11)。零用户感知,重启自动。
// 功能:世界书/条目 CRUD + 自研指针拖拽排序(无 HTML5 DnD,杜绝 no-drop 光标闪动;
//   整行/整卡为拖源与落点,源变暗,半透明插入预览随指针实时移动,空隙与条目内部均可落点)。
// 条目折叠态首行=标题(comment);输入/确认全用窗口内模态框;关闭在未保存时二次确认。
//
// ⚠ 防线(§13.8 教训 2):模块级 inject 保持 ['slots'],禁止追加 'remote' 等未验证服务键。
window.__ModuleLoader__.load({
  id: 'dsh-universal-worldbook',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var open = false
    var listeners = []
    var fmtDefaultsCache = null // GET /format 的 defaults(恢复默认按钮用),模块级缓存
    function setOpen(v) {
      open = !!v
      listeners.slice().forEach(function (fn) { try { fn(open) } catch (e) {} })
    }
    function subscribe(fn) {
      listeners.push(fn)
      return function () {
        var i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
    function useOpen() {
      var s = React.useState(open)
      React.useEffect(function () { return subscribe(s[1]) }, [])
      return s[0]
    }

    // —— 指针拖拽状态(模块级,跨渲染共享,事件闭包读最新值)——
    var ptr = { mode: null, id: null, x0: 0, y0: 0, moved: false, bookHint: null, entryHint: null, node: null, offX: 0, offY: 0 }
    var live = { books: null, raw: null, loaded: null } // loaded=当前 raw 所属的书 id(切换加载期保护)
    var edits = {} // 未保存编辑缓存:bookId -> { entries }(切换/关闭时自动保存,保存成功清除)
    var lastSel = null // 切换世界书自动保存追踪
    var selRef = null // sel 的模块级实时引用(供跨渲染注册的一次性监听回调读取最新选中书)
    var switchSeq = 0 // 书切换加载令牌:迟到的异步加载/刷新一律丢弃,防串书
    var viewSessionId = null // 会话级 seat 捕获的"当前聚焦会话"id
    var savedTimer = null // "已保存"提示自动熄灭计时
    var openedSet = {} // 曾展开过的条目 uid(展开后保持 body 挂载以支持收起过渡)
    function ensureAnimStyle() {
      try {
        if (!globalThis.document) return
        if (document.getElementById('uwb-grow-keyframes')) return
        var st = document.createElement('style')
        st.id = 'uwb-grow-keyframes'
        st.textContent = '@keyframes uwbGrow{from{max-height:0px}to{max-height:1600px}}'
        document.head.appendChild(st)
      } catch (e) { /* ignore */ }
    }
    function notifyScopeChanged() {
      try { if (globalThis.window && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('uwb-scope-change')) } catch (e) {}
    }

    // —— DOM 克隆幽灵(与原行完全一致的拖拽预览)——
    var ghostHost = null
    function ghostClear() {
      if (ghostHost) { try { ghostHost.remove() } catch (e) {} ghostHost = null }
    }
    function ghostInit(node, x, y) {
      ghostClear()
      if (!node || !document.body) return
      var rect = node.getBoundingClientRect()
      var host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;opacity:.92;z-index:80;will-change:transform;'
      host.style.width = rect.width + 'px'
      var clone = node.cloneNode(true)
      clone.style.pointerEvents = 'none'
      clone.style.margin = '0'
      clone.style.transform = 'none'
      host.appendChild(clone)
      document.body.appendChild(host)
      ghostHost = host
      ghostMove(x, y)
    }
    function ghostMove(x, y) {
      if (ghostHost) ghostHost.style.transform = 'translate(' + x + 'px,' + y + 'px)'
    }

    // —— /uwb-api 同源数据 ——
    function parseResp(path, r) {
      return r.text().then(function (t) {
        var d = null
        try { d = JSON.parse(t) } catch (e) { /* 非 JSON */ }
        if (d && d.ok) return d
        var hint = (d && d.err) || ('HTTP ' + r.status)
        throw new Error('api ' + path + ' 失败: ' + hint)
      })
    }
    function apiGet(path) {
      return globalThis.fetch(path, { headers: { accept: 'application/json' } }).then(function (r) { return parseResp(path, r) })
    }
    function apiPost(path, body) {
      return globalThis.fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) { return parseResp(path, r) })
    }

    // —— 主题化内联样式 ——
    var C = {
      border: 'var(--dsw-alias-border-l1)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      err: 'var(--dsw-alias-state-error-primary)'
    }
    var sBtn = { margin: '2px 4px', border: '1px solid ' + C.border, borderRadius: '6px', padding: '3px 9px', background: 'transparent', color: C.label2, fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }
    var sBtnBrand = { margin: '2px 4px', border: '1px solid ' + C.brand, borderRadius: '6px', padding: '3px 9px', background: C.brand, color: '#fff', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }
    var sBtnDanger = { margin: '2px 4px', border: '1px solid ' + C.err, borderRadius: '6px', padding: '3px 9px', background: 'transparent', color: C.err, fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }
    var sInput = { border: '1px solid ' + C.border, borderRadius: '5px', padding: '3px 6px', background: 'transparent', color: C.label, fontSize: '12px', width: '100%', boxSizing: 'border-box' }
    var sLabel = { fontSize: '11px', color: C.label2, display: 'block', margin: '6px 0 2px' }
    var sMask = { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.4)', pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40 }
    var sWin = { pointerEvents: 'auto', display: 'flex', flexDirection: 'column', width: 'min(1040px,94vw)', height: 'min(720px,90vh)', background: C.overlay, color: C.label, border: '1px solid ' + C.border, borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,.35)', overflow: 'hidden' }
    var sHead = { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid ' + C.border, flexWrap: 'wrap' }
    var sTitle = { fontWeight: 600, fontSize: '14px', marginRight: '4px' }
    var sStatus = { fontSize: '11px', color: C.label2, flex: '1' }
    var sErr = { color: C.err, fontSize: '12px', whiteSpace: 'pre-wrap', padding: '6px 12px', borderBottom: '1px solid ' + C.border }
    var sBody = { flex: '1', display: 'flex', minHeight: '0' }
    var sSide = { width: '240px', borderRight: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', minHeight: '0' }
    var sSideHead = { padding: '6px 8px', borderBottom: '1px solid ' + C.border, fontSize: '11px', color: C.label2 }
    var sBookList = { flex: '1', overflow: 'auto', padding: '4px' }
    var sBookItem = { padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', color: C.label2, display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'center' }
    var sBookItemSel = { padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', color: '#fff', background: C.brand, display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'center' }
    var sDot = { width: '13px', height: '13px', borderRadius: '50%', border: '1.5px solid var(--dsw-alias-label-primary)', background: '#fff', position: 'relative', flexShrink: '0', boxSizing: 'border-box', cursor: 'pointer' }
    var sDotInner = { position: 'absolute', inset: '2px', borderRadius: '50%', background: C.success }
    var sMain = { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' }
    var sToolbar = { padding: '4px 8px', borderBottom: '1px solid ' + C.border, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px' }
    // 左栏底部工具按钮:显式 4 行(行内 flex 平分宽度);配色沿用原画风(sBtn/sBtnDanger/sBtn)
    var sToolCol = { padding: '4px 8px', borderBottom: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', gap: '2px' }
    var sToolRow = { display: 'flex', width: '100%', gap: '4px' }
    var sToolBtn = Object.assign({}, sBtn, { flex: '1 1 0%', minWidth: '0', textAlign: 'center' })
    var sToolBtnDanger = Object.assign({}, sBtnDanger, { flex: '1 1 0%', minWidth: '0', textAlign: 'center' })
    var sEntryList = { flex: '1', overflow: 'auto', padding: '8px' }
    var sRow = { border: '1px solid ' + C.border, borderRadius: '8px', marginBottom: '6px', overflow: 'hidden' }
    var sRowHead = { padding: '6px 8px', cursor: 'pointer' }
    var sRowLine1 = { display: 'flex', alignItems: 'center', gap: '6px' }
    var sDrag = { cursor: 'grab', color: C.label2, fontSize: '13px', padding: '0 2px', flexShrink: '0' }
    var sRowTitle = { color: C.label, fontSize: '12px', fontWeight: 600, flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var sRowMeta = { color: C.label2, fontSize: '11px', flexShrink: '0' }
    var sRowLine2 = { marginTop: '2px', fontSize: '11px', color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var sRowLine2Key = { color: C.brand }
    var sRowBody = { padding: '6px 10px', borderTop: '1px solid ' + C.border }
    var sTextarea = { width: '100%', boxSizing: 'border-box', minHeight: '60px', border: '1px solid ' + C.border, borderRadius: '5px', padding: '4px 6px', background: 'transparent', color: C.label, fontSize: '12px', fontFamily: 'inherit', resize: 'vertical' }
    var sRowField = { margin: '6px 0' }
    var sEmpty = { padding: '10px 14px', color: C.label2, fontSize: '12px' }
    var sBadge = { fontSize: '11px', borderRadius: '4px', padding: '0 5px', border: '1px solid ' + C.border, color: C.label2, flexShrink: '0' }
    var sInsert = { height: '3px', borderRadius: '2px', background: C.brand, opacity: 0.55, margin: '2px 6px', pointerEvents: 'none', flexShrink: '0' }
    var sModalMask = { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.45)', pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }
    var sModalBox = { pointerEvents: 'auto', width: 'min(420px,86vw)', background: C.overlay, color: C.label, border: '1px solid ' + C.border, borderRadius: '10px', boxShadow: '0 12px 40px rgba(0,0,0,.4)', padding: '14px', fontSize: '13px' }
    var sModalTitle = { fontWeight: 600, marginBottom: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
    var sModalBtns = { display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }

    // —— 数据助手 ——
    function sortedUids(map) {
      var arr = Object.keys(map || {}).map(function (k) { return { uid: k, order: typeof map[k].order === 'number' ? map[k].order : 0 } })
      arr.sort(function (a, b) { return a.order - b.order || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0) })
      return arr.map(function (x) { return x.uid })
    }
    function nextNumericUid(map) {
      var max = -1
      Object.keys(map || {}).forEach(function (k) { if (/^\d+$/.test(k)) { var n = Number(k); if (n > max) max = n } })
      return String(max + 1)
    }
    function maxOrder(map) {
      var mx = 0
      Object.keys(map || {}).forEach(function (k) { var o = map[k].order; if (typeof o === 'number' && o > mx) mx = o })
      return mx
    }
    function defaultEntry(uid, order) {
      return {
        uid: Number(uid), key: [], keysecondary: [], comment: '', content: '', constant: false,
        vectorized: false, selective: false, selectiveLogic: 0, addMemo: true, order: order,
        position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
        delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, group: '',
        groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
        useGroupScoring: null, automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0,
        triggers: [], displayIndex: 0
      }
    }
    function keysToText(arr) { return Array.isArray(arr) ? arr.join(' | ') : '' }
    function rowView(map, uid) {
      var en = map[uid] || {}
      return {
        uid: uid,
        constant: en.constant === true,
        keys: Array.isArray(en.key) ? en.key : [],
        secondaryKeys: Array.isArray(en.keysecondary) ? en.keysecondary : [],
        selective: en.selective === true,
        selectiveLogic: Number.isFinite(Number(en.selectiveLogic)) ? Number(en.selectiveLogic) : 0,
        comment: String(en.comment || '').trim(),
        content: String(en.content || ''),
        order: typeof en.order === 'number' ? en.order : 0,
        disable: en.disable === true
      }
    }
    // —— ST worldbook JSON 解析/导出辅助 ——
    function sanitizeBookId(name) {
      var s = String(name || 'worldbook').trim()
      s = s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[-._]+/, '')
      if (s === '') s = 'worldbook'
      return s.slice(0, 80)
    }
    function parseStWorldbook(text) {
      var doc = null
      try { doc = JSON.parse(text) } catch (e) { throw new Error('不是有效 JSON:' + String((e && e.message) || e)) }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('JSON 顶层应为对象(SillyTavern worldbook:{ "entries": {...} })')
      var entries = doc.entries
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('缺少 entries 对象:不是 ST worldbook 格式')
      var keys = Object.keys(entries)
      if (keys.length === 0) throw new Error('entries 为空(没有条目)')
      for (var i = 0; i < keys.length; i++) {
        var en = entries[keys[i]]
        if (!en || typeof en !== 'object' || Array.isArray(en)) throw new Error('条目 "' + keys[i] + '" 不是对象')
      }
      return { entries: entries }
    }
    function downloadText(filename, text) {
      try {
        var blob = new Blob([text], { type: 'application/json;charset=utf-8' })
        var url = globalThis.URL.createObjectURL(blob)
        var a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        globalThis.URL.revokeObjectURL(url)
      } catch (e) { return String((e && e.message) || e) }
      return null
    }
    // 容器内插入位:以行矩形中点切分(空隙/条目内部都算,行高<8px 的预览条跳过)
    function dropIndexFromPointer(rootEl, clientY) {
      var rows = []
      var kids = rootEl && rootEl.children ? rootEl.children : []
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect()
        if (r.height < 8) continue
        rows.push({ mid: r.top + r.height / 2 })
      }
      for (var j = 0; j < rows.length; j++) {
        if (clientY < rows[j].mid) return j
      }
      return rows.length
    }

    var inject = ['slots']

    function apply(ctx) {
      ensureAnimStyle()
      if (!ctx.slots) return
      var slots = ctx.slots

      ctx.effect(function () {
        return slots.inject('sidebar.footer.action', function () {
          return slots.register({
            name: 'sidebar.footer.action', id: 'uwb-open', order: 20, label: '世界书'
          }, function FooterAction(props) {
            var isOpen = useOpen()
            var wide = !!(props && props.wide)
            return React.createElement('button', {
              style: { margin: '2px 4px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '4px 10px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' },
              title: '通用世界书(WorldBook)', onClick: function () { setOpen(!isOpen) }
            }, wide ? '世界书' : '书')
          })
        })
      }, 'uwb: sidebar.footer.action')

      // 会话级隐形 occupant:捕获当前聚焦会话 id(窗口据此自动对准其工作区)
      ctx.effect(function () {
        return slots.inject('conversation.input.dock', function () {
          return slots.register({ name: 'conversation.input.dock', id: 'uwb-viewscope', order: -100 }, function UwbViewScope(props) {
            var sid = props && props.sessionId
            if (sid && sid !== viewSessionId) { viewSessionId = sid; notifyScopeChanged() }
            return null
          })
        })
      }, 'uwb: conversation.input.dock')

      ctx.effect(function () {
        return slots.inject('shell.overlay', function () {
          return slots.register({ name: 'shell.overlay', id: 'uwb-window', order: 0 }, function UwbWindow() {
            var isOpen = useOpen()
            var booksSt = React.useState(null); var books = booksSt[0]; var setBooks = booksSt[1]
            var selSt = React.useState(null); var sel = selSt[0]; var setSel = selSt[1]
            var rawSt = React.useState(null); var raw = rawSt[0]; var setRaw = rawSt[1]
            var expandSt = React.useState(null); var expand = expandSt[0]; var setExpand = expandSt[1]
            var dirtySt = React.useState(false); var dirty = dirtySt[0]; var setDirty = dirtySt[1]
            var errSt = React.useState(null); var err = errSt[0]; var setErr = errSt[1]
            var busySt = React.useState(false); var busy = busySt[0]; var setBusy = busySt[1]
            var dragModeSt = React.useState(null); var dragMode = dragModeSt[0]; var setDragMode = dragModeSt[1]
            var dragIdSt = React.useState(null); var dragId = dragIdSt[0]; var setDragId = dragIdSt[1]
            var bookHintSt = React.useState(null); var bookHint = bookHintSt[0]; var setBookHint = bookHintSt[1]
            var entryHintSt = React.useState(null); var entryHint = entryHintSt[0]; var setEntryHint = entryHintSt[1]
            var sizesSt = React.useState({}); var sizes = sizesSt[0]; var setSizes = sizesSt[1]
            var scopeSt = React.useState(null); var scope = scopeSt[0]; var setScope = scopeSt[1]
            var effSt = React.useState([]); var effective = effSt[0]; var setEffective = effSt[1]
            var modalSt = React.useState(null); var modal = modalSt[0]; var setModal = modalSt[1]
            var promptValSt = React.useState(''); var promptVal = promptValSt[0]; var setPromptVal = promptValSt[1]
            var fmtSt = React.useState(null); var fmt = fmtSt[0]; var setFmt = fmtSt[1] // {header, tail}
            var fmtHeaderSt = React.useState(''); var fmtHeader = fmtHeaderSt[0]; var setFmtHeader = fmtHeaderSt[1]
            var fmtTailSt = React.useState(''); var fmtTail = fmtTailSt[0]; var setFmtTail = fmtTailSt[1]
            var settingsSt = React.useState(null); var settings = settingsSt[0]; var setSettings = settingsSt[1] // {scanDepth,hitPreview}
            var previewSt = React.useState([]); var previewUids = previewSt[0]; var setPreviewUids = previewSt[1] // 命中预览 uidKey[]
            var savedSt = React.useState(''); var savedMsg = savedSt[0]; var setSavedMsg = savedSt[1] // "已保存"即时提示
            var gateSt = React.useState({}); var gates = gateSt[0]; var setGates = gateSt[1] // 输入 gate:{uid:'comment'|'order'}

            // 输入"单击进入"gate:gate 外=可拖行、手指光标、只读防误选;进入后=可编辑选中、该行拖行禁用
            function gateKey(uid, f) { return uid + ':' + f }
            function isGated(uid, f) { return !!gates[gateKey(uid, f)] }
            function rowGated(uid) { return isGated(uid, 'comment') || isGated(uid, 'order') }
            function openGate(uid, f) {
              setGates(function (g) { var n = Object.assign({}, g); n[gateKey(uid, f)] = 1; return n })
              // 进入后聚焦并定位到末尾(等 gate 生效的下一帧)
              globalThis.setTimeout(function () {
                try {
                  var el = document.querySelector('[data-uwb-gate="' + gateKey(uid, f) + '"]')
                  if (el) {
                    el.focus()
                    var L = el.value ? el.value.length : 0
                    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(L, L)
                  }
                } catch (e) { /* ignore */ }
              }, 0)
            }
            function closeGate(uid, f) {
              setGates(function (g) { if (!g[gateKey(uid, f)]) return g; var n = Object.assign({}, g); delete n[gateKey(uid, f)]; return n })
            }
            function clearGates() { setGates({}) }

            // 关键:窗口级 mousemove/mouseup 监听只注册一次,回调闭包会把 sel 定格在"开窗那刻";
            // 故拖拽等由陈旧闭包触发的路径必须读模块级实时引用 selRef,而不是闭包里的 sel。
            selRef = sel

            function openPrompt(title, def) {
              setPromptVal(def === undefined || def === null ? '' : String(def))
              return new Promise(function (resolve) {
                setModal({ kind: 'prompt', title: title, resolve: resolve })
              })
            }
            function openChoice(title, buttons) {
              return new Promise(function (resolve) {
                setModal({ kind: 'choice', title: title, buttons: buttons, resolve: resolve })
              })
            }
            function modalDone(value) {
              var m = modal
              if (m && m.resolve) m.resolve(value)
              setModal(null)
            }
            // —— 通用头/尾提示词编辑(弹窗内含两个多行输入 + 保存/取消/恢复默认)——
            function fmtText(d, key, fallback) {
              return (d && typeof d[key] === 'string') ? d[key] : (fallback || '')
            }
            function openFmtModal() {
              // 先取服务器当前值(含 defaults 缓存),再开窗
              apiGet('/uwb-api/format').then(function (d) {
                if (d && d.format) setFmt(d.format)
                if (d && d.defaults) fmtDefaultsCache = d.defaults
                setFmtHeader(fmtText(d && d.format, 'header', fmtText(fmt, 'header', '')))
                setFmtTail(fmtText(d && d.format, 'tail', fmtText(fmt, 'tail', '')))
                setModal({ kind: 'format', title: '通用头/尾提示词(包裹命中内容)' })
              }).catch(function (e) {
                setErr(String((e && e.message) || e))
                // 网络失败也允许打开(用本地缓存值)
                setFmtHeader(fmtText(fmt, 'header', ''))
                setFmtTail(fmtText(fmt, 'tail', ''))
                setModal({ kind: 'format', title: '通用头/尾提示词(包裹命中内容)' })
              })
            }
            function fmtRestoreDefaults() {
              var dflt = fmtDefaultsCache || {}
              setFmtHeader(fmtText(dflt, 'header', ''))
              setFmtTail(fmtText(dflt, 'tail', ''))
            }
            function fmtSave() {
              var header = fmtHeader
              var tail = fmtTail
              setBusy(true)
              apiPost('/uwb-api/format', { header: header, tail: tail }).then(function (d) {
                setBusy(false)
                if (d && d.format) setFmt(d.format)
                modalDone(null)
              }).catch(function (e) {
                setBusy(false)
                setErr(String((e && e.message) || e))
              })
            }

            function reloadState(preserveSel) {
              var path = '/uwb-api/state'
              if (viewSessionId) path += '?sid=' + encodeURIComponent(viewSessionId)
              return apiGet(path).then(function (d) {
                setBooks(d.books || [])
                setScope(d.scope || null)
                setEffective(Array.isArray(d.effective) ? d.effective : [])
                if (d.format) setFmt(d.format)
                if (d.formatDefaults) fmtDefaultsCache = d.formatDefaults
                if (d.settings) setSettings(d.settings)
                if (Array.isArray(d.preview)) setPreviewUids(d.preview)
                else setPreviewUids([])
                setSel(function (prev) {
                  var want = preserveSel || prev
                  var list = d.books || []
                  if (want && list.some(function (b) { return b.id === want })) return want
                  return (list[0] && list[0].id) || null
                })
                return d
              })
            }
            // 载入世界书条目:优先返回未保存编辑缓存;forceServer=true 则强制取服务器并清缓存(保存后)
            // token=切换令牌:迟到的旧切换加载结果直接丢弃(防 A 书内容落进 B 书)
            function reloadRaw(id, forceServer, token) {
              setSizes({})
              setGates({}) // 换书/重载后旧行的输入 gate 一律失效
              if (!forceServer && edits[id]) {
                live.loaded = id
                live.raw = edits[id].entries
                setRaw(edits[id].entries)
                setExpand(null)
                setDirty(true)
                return Promise.resolve()
              }
              return apiGet('/uwb-api/book/' + encodeURIComponent(id)).then(function (d) {
                if (token !== undefined && token !== switchSeq) return // 迟到旧切换:丢弃
                if (edits[id]) delete edits[id]
                live.loaded = id
                live.raw = d.entries || {}
                setRaw(d.entries || {})
                setExpand(null)
                setDirty(false)
              })
            }
            React.useEffect(function () {
              if (!isOpen) return
              var dead = false
              setErr(null)
              // 组件跨开关保持挂载:打开窗口时清掉上次可能残留的拖拽态与输入 gate
              if (ptr.mode !== null || dragMode !== null) endDrag()
              clearGates()
              reloadState(null).catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
              return function () { dead = true }
            }, [isOpen])
            React.useEffect(function () {
              if (!isOpen) return
              // Esc 关闭整个世界书窗口(输入框内的 Esc 已 stopPropagation,只退出编辑不关窗)
              function onKeyEsc(e) {
                if (e.key === 'Escape') doClose()
              }
              window.addEventListener('keydown', onKeyEsc)
              return function () { window.removeEventListener('keydown', onKeyEsc) }
            }, [isOpen])
            React.useEffect(function () {
              if (!isOpen) return
              if (!sel) { lastSel = null; return }
              var dead = false
              var prev = lastSel
              lastSel = sel
              switchSeq += 1
              var seq = switchSeq
              var chain = Promise.resolve()
              if (sel && prev && prev !== sel) chain = flushBook(prev).catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
              chain.then(function () {
                return reloadRaw(sel, false, seq)
              }).then(function () {
                // 保存(切走)后服务器 vault 已更新 → 重取 /state 让命中预览同步;仅本代切换有效
                if (seq === switchSeq && isOpen) reloadState(sel).catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
              }).catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
              return function () { dead = true }
            }, [isOpen, sel])
            React.useEffect(function () {
              if (!isOpen) return
              function onScopeChange() {
                reloadState(sel).catch(function (e) { setErr(String((e && e.message) || e)) })
              }
              window.addEventListener('uwb-scope-change', onScopeChange)
              return function () { window.removeEventListener('uwb-scope-change', onScopeChange) }
            }, [isOpen])
            // 指针拖拽监听(hooks 必须在 early-return 之前;回调引用的函数为提升声明,可后置)
            React.useEffect(function () {
              if (!isOpen) return
              window.addEventListener('mousemove', onWinMove)
              window.addEventListener('mouseup', onWinUp)
              return function () {
                window.removeEventListener('mousemove', onWinMove)
                window.removeEventListener('mouseup', onWinUp)
                endDrag()
              }
            }, [isOpen])
            // 展开条目:先归零→量取内容真实高→再过渡(实测高度动画,上下两侧都真正匀速)
            React.useEffect(function () {
              if (!isOpen || !expand) return
              var uid = expand
              setSizes(function (cur) { var n = Object.assign({}, cur); n[uid] = 0; return n })
              var raf = (typeof globalThis.requestAnimationFrame === 'function')
                ? globalThis.requestAnimationFrame
                : function (fn) { return globalThis.setTimeout(fn, 16) }
              raf(function () {
                raf(function () {
                  var el = document.querySelector('[data-uwb-body="' + uid + '"]')
                  if (!el) return
                  var h = Math.max(1, Math.ceil(el.scrollHeight))
                  setSizes(function (cur) { var n = Object.assign({}, cur); n[uid] = h; return n })
                })
              })
            }, [isOpen, expand])
            if (!isOpen) return null

            live.books = books
            live.raw = raw

            function currentEntries() {
              // 切换加载期(loaded≠sel)不读旧书内容 → 返回空,杜绝"在 B 书名下编辑 A 的内容"
              var curSel = selRef
              if (curSel && live.loaded !== null && live.loaded !== curSel) return {}
              return (edits[curSel] && edits[curSel].entries) || live.raw || raw || {}
            }
            function commitEntries(next, mode) {
              var curSel = selRef
              // 加载完成前的写入一律丢弃(宁可丢击键,不可把内容写进错误的书);给出可见提示而非静默
              if (curSel && live.loaded !== null && live.loaded !== curSel) {
                flashMsg('书内容加载中,本次改动已忽略(稍候再改)')
                return
              }
              live.raw = next
              if (curSel) edits[curSel] = { entries: next }
              setRaw(next)
              setDirty(true)
              // 保存策略:编辑输入中仅本地缓存(不逐键写盘,避免读写浪费);
              //   落盘时机 = 失焦/回车提交、拖动排序/增删条目/开关/逻辑等单次动作(immediate),
              //   以及切书/关闭窗口的 flush 兜底。
              var m = mode || 'local'
              if (m === 'immediate') enqueueSave(curSel, 0)
              // 'local'(默认)= 只更新缓存与本地态,不触发写盘(输入中的每次击键)
            }
            // 拖动排序专用提交通道:拖的是当前可见书,不受"加载期保护"误判影响(防串书逻辑对拖动无意义)
            function commitForReorder(next) {
              var curSel = selRef
              if (!curSel) return
              live.raw = next
              edits[curSel] = { entries: next }
              setRaw(next)
              setDirty(true)
              enqueueSave(curSel, 0)
            }
            function patchEntry(uid, patch, mode) {
              var cur = currentEntries()
              var next = Object.assign({}, cur)
              next[uid] = Object.assign({}, cur[uid] || {}, patch)
              commitEntries(next, mode)
            }
            // —— 保存引擎:每本书串行落盘 + 序号防旧响应覆盖新内容 + 去抖 ——
            var saveTimers = {} // bookId -> timer
            var saveSeqs = {} // bookId -> 已入队序号
            var saveChains = {} // bookId -> promise 尾(串行化,切换/关闭可 await)
            function deepCopy(x) { try { return JSON.parse(JSON.stringify(x)) } catch { return x } }
            function flashMsg(msg, ms) {
              if (savedTimer) globalThis.clearTimeout(savedTimer)
              setSavedMsg(msg)
              savedTimer = globalThis.setTimeout(function () { setSavedMsg(''); savedTimer = null }, ms || 2600)
            }
            function flashSaved(id) {
              var d = new Date()
              var p = function (n) { return (n < 10 ? '0' : '') + n }
              flashMsg('已保存「' + id + '」 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()))
            }
            function doSave(id) {
              var en = edits[id]
              if (!en || !en.entries) return
              var entries = en.entries
              var payload = deepCopy(entries)
              var seq = (saveSeqs[id] || 0) + 1
              saveSeqs[id] = seq
              var prev = saveChains[id] || Promise.resolve()
              var p = prev.then(function () {
                return apiPost('/uwb-api/save', { id: id, entries: payload })
              }).then(function () {
                // 仅当该快照仍是最新时清缓存(本地=服务器);期间有新编辑则留给下一轮保存清理
                if (edits[id] && edits[id].entries === entries && saveSeqs[id] === seq) delete edits[id]
                flashSaved(id)
              }).catch(function (e) { setErr(String((e && e.message) || e)) })
              saveChains[id] = p
              return p
            }
            function enqueueSave(id, delay) {
              if (!id) return
              if (saveTimers[id]) { clearTimeout(saveTimers[id]); saveTimers[id] = null }
              if (delay > 0) saveTimers[id] = setTimeout(function () { saveTimers[id] = null; doSave(id) }, delay)
              else doSave(id)
            }
            function flushBook(id) {
              // 切换/关闭兜底:取消未触发的去抖并立即落盘,等待本书记录保存链
              if (saveTimers[id]) { clearTimeout(saveTimers[id]); saveTimers[id] = null }
              if (edits[id]) doSave(id)
              return saveChains[id] || Promise.resolve()
            }
            function flushAllBooks() {
              var ids = Object.keys(edits)
              Object.keys(saveChains).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id) })
              var p = Promise.resolve()
              ids.forEach(function (id) { p = p.then(function () { return flushBook(id) }) })
              return p
            }
            function doClose() {
              setBusy(true); setErr(null)
              flushAllBooks()
                .then(function () { setBusy(false); lastSel = null; setOpen(false) })
                .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
            }
            function newBook() {
              setBusy(true); setErr(null)
              openPrompt('新世界书 id(文件名,字母/数字/._-):', '').then(function (v) {
                if (v === null) { setBusy(false); return }
                var id = String(v).trim()
                if (id === '') { setBusy(false); setErr('id 不能为空'); return }
                apiPost('/uwb-api/book/create', { id: id }).then(function () {
                  return reloadState(id)
                }).then(function () { setBusy(false) })
                  .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
              })
            }
            function renameBook() {
              if (!sel) return
              var oldId = sel
              openPrompt('重命名「' + oldId + '」→ 新 id:', oldId).then(function (v) {
                if (v === null) return
                var id = String(v).trim()
                if (id === '' || id === oldId) return
                setBusy(true); setErr(null)
                apiPost('/uwb-api/book/rename', { id: oldId, newId: id }).then(function () {
                  if (edits[oldId]) { edits[id] = edits[oldId]; delete edits[oldId] }
                  return reloadState(id)
                }).then(function () { setBusy(false) })
                  .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
              })
            }
            function copyBook() {
              if (!sel) return
              var oldId = sel
              openPrompt('复制「' + oldId + '」为 id:', oldId + '-copy').then(function (v) {
                if (v === null) return
                var id = String(v).trim()
                if (id === '') return
                setBusy(true); setErr(null)
                apiPost('/uwb-api/book/copy', { id: oldId, newId: id }).then(function () {
                  return reloadState(id)
                }).then(function () { setBusy(false) })
                  .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
              })
            }
            function deleteBook() {
              if (!sel) return
              var oldId = sel
              openChoice('删除世界书「' + oldId + '」?(文件+.bak 一并删除,并从启用表移除)', [
                { label: '删除', value: 'ok', danger: true },
                { label: '取消', value: 'cancel' }
              ]).then(function (v) {
                if (v !== 'ok') return
                setBusy(true); setErr(null)
                apiPost('/uwb-api/book/delete', { id: oldId }).then(function () {
                  if (edits[oldId]) delete edits[oldId]
                  setRaw(null); setSel(null)
                  return reloadState(null)
                }).then(function () { setBusy(false) })
                  .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
              })
            }
            function doToggle(id, wantOn) {
              return apiPost('/uwb-api/toggle', { id: id, on: wantOn, sid: viewSessionId || undefined })
                .then(function () { return reloadState(sel) })
            }
            function toggleBook(id, wantOn) {
              doToggle(id, wantOn).catch(function (e) { setErr(String((e && e.message) || e)) })
            }
            // —— 扫描深度 / 命中预览(写入 /settings 后整体刷新 state,含预览 uid 更新)——
            var settingsTimer = null
            function saveSettings(patch, immediate) {
              var next = Object.assign({}, settings || {}, patch)
              setSettings(next)
              if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null }
              if (!immediate) {
                settingsTimer = setTimeout(function () { settingsTimer = null; saveSettings(patch, true) }, 350)
                return
              }
              setBusy(true)
              return apiPost('/uwb-api/settings', {
                scanDepth: typeof next.scanDepth === 'number' ? next.scanDepth : 3,
                hitPreview: next.hitPreview !== false
              }).then(function () {
                setBusy(false)
                return reloadState(sel)
              }).catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)) })
            }
            function onScanDepth(e) {
              var v = parseInt(e && e.target && e.target.value, 10)
              if (!Number.isFinite(v)) return
              saveSettings({ scanDepth: Math.min(5, Math.max(1, v)) })
            }
            function onHitPreview(e) {
              if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null }
              saveSettings({ hitPreview: !!(e && e.target && e.target.checked) }, true)
            }
            function doExport() {
              if (!sel) return
              try {
                var cur = currentEntries()
                var out = JSON.stringify({ entries: cur }, null, 2)
                var er = downloadText(sel + '.json', out)
                if (er) setErr(er)
              } catch (e) { setErr(String((e && e.message) || e)) }
            }
            function onImportFile(e) {
              var input = e && e.target
              var file = input && input.files && input.files[0]
              if (input) input.value = ''
              if (!file) return
              setBusy(true); setErr(null)
              var reader = new FileReader()
              reader.onerror = function () { setBusy(false); setErr('读取文件失败') }
              reader.onload = function () {
                var parsed = null
                try { parsed = parseStWorldbook(String(reader.result)) } catch (ex) { setBusy(false); setErr((ex && ex.message) || String(ex)); return }
                var base = sanitizeBookId(String(file.name).replace(/\.json$/i, ''))
                var exists = (books || []).some(function (b) { return b.id === base })
                var choose = function (id) {
                  if (id === null) { setBusy(false); return }
                  id = String(id).trim()
                  if (id === '') { setBusy(false); setErr('导入 id 不能为空'); return }
                  apiPost('/uwb-api/save', { id: id, entries: parsed.entries }).then(function () {
                    return reloadState(id)
                  }).then(function () { setBusy(false); setErr(null) })
                    .catch(function (ex) { setBusy(false); setErr(String((ex && ex.message) || ex)) })
                }
                if (exists) {
                  openPrompt('「' + base + '」已存在,导入为新 id:', base + '-import').then(choose)
                } else {
                  choose(base)
                }
              }
              reader.readAsText(file)
            }
            function setEntryEnabled(uid, enabled) { patchEntry(uid, { disable: !enabled }, 'immediate') }
            function setEntryConstant(uid, constant) { patchEntry(uid, { constant: constant }, 'immediate') }
            function copyEntry(uid) {
              var cur = currentEntries()
              var src = cur[uid]
              if (!src) return
              var nuid = nextNumericUid(cur)
              var clone
              try { clone = JSON.parse(JSON.stringify(src)) } catch (e) { clone = Object.assign({}, src) }
              clone.uid = Number(nuid)
              var next = Object.assign({}, cur)
              next[nuid] = clone
              commitEntries(next, 'immediate')
            }
            function addEntry() {
              if (!sel) return
              var cur = currentEntries()
              var uid = nextNumericUid(cur)
              var entry = defaultEntry(uid, maxOrder(cur) + 10)
              var next = Object.assign({}, cur)
              next[uid] = entry
              commitEntries(next, 'immediate')
              openedSet[uid] = 1
              setExpand(uid)
            }
            function deleteEntry(uid) {
              var cur0 = currentEntries()
              var en0 = (cur0 && cur0[uid]) || {}
              var label = String((en0 && en0.comment) || '').trim() || ('条目 ' + uid)
              openChoice('删除条目「' + label + '」?', [
                { label: '删除', value: 'ok', danger: true },
                { label: '取消', value: 'cancel' }
              ]).then(function (v) {
                if (v !== 'ok') return
                closeGate(uid, 'comment'); closeGate(uid, 'order')
                var cur = currentEntries()
                var next = Object.assign({}, cur)
                delete next[uid]
                commitEntries(next, 'immediate')
                if (expand === uid) setExpand(null)
              })
            }

            // —— 自研指针拖拽(无 HTML5 DnD,无 no-drop 光标)——
            function moveBookTo(fromId, hint) {
              var ids = (live.books || []).map(function (b) { return b.id })
              var fi = ids.indexOf(fromId)
              if (fi < 0) return
              ids.splice(fi, 1)
              var ins = hint
              if (fi < ins) ins -= 1
              ins = Math.max(0, Math.min(ins, ids.length))
              ids.splice(ins, 0, fromId)
              var byId = {}
              ;(live.books || []).forEach(function (b) { byId[b.id] = b })
              setBooks(ids.map(function (id) { return byId[id] }))
              apiPost('/uwb-api/books/order', { ids: ids }).catch(function (e) { setErr(String((e && e.message) || e)) })
            }
            function moveEntryTo(fromUid, hint) {
              var list = sortedUids(currentEntries())
              var fi = list.indexOf(fromUid)
              if (fi < 0) return
              list.splice(fi, 1)
              var ins = hint
              if (fi < ins) ins -= 1
              ins = Math.max(0, Math.min(ins, list.length))
              list.splice(ins, 0, fromUid)
              var next = Object.assign({}, currentEntries())
              list.forEach(function (uid, idx) { next[uid] = Object.assign({}, next[uid], { order: (idx + 1) * 10 }) })
              commitForReorder(next) // 拖动排序立即落盘(专用通道,不受加载期保护误判)
            }
            function endDrag() {
              ptr.mode = null; ptr.id = null; ptr.moved = false
              ptr.node = null
              ptr.bookHint = null; ptr.entryHint = null
              setDragMode(null); setDragId(null)
              setBookHint(null); setEntryHint(null)
              ghostClear()
              if (document.body) document.body.style.userSelect = ''
            }
            // 真实拖拽结束后的那次 click 只表达"放下",吞掉以免触发展开/选中(与单击语义区分)
            function swallowNextClick() {
              var timer = null
              var h = function (e) {
                e.preventDefault(); e.stopPropagation()
                cleanup()
              }
              function cleanup() {
                if (timer) { globalThis.clearTimeout(timer); timer = null }
                document.removeEventListener('click', h, true)
              }
              timer = globalThis.setTimeout(cleanup, 200)
              document.addEventListener('click', h, true)
            }
            function rowDown(mode, id, ev) {
              if (ev.button !== 0) return
              // 自愈:上次 mouseup 可能丢失(拖出窗口/快速开合)→ 残留拖拽态先清,否则新拖拽被旧状态卡住
              if (ptr.mode !== null) endDrag()
              var t = ev.target
              if (t && t.closest && t.closest('button,select,a,label')) return
              var tag = t && t.tagName ? String(t.tagName).toLowerCase() : ''
              var onField = tag === 'input' || tag === 'textarea'
              // 输入区也允许作为拖源:不 preventDefault(保留聚焦/光标),拖过阈值后由 onWinMove 接管失焦
              if (!onField) ev.preventDefault()
              ptr.mode = mode; ptr.id = id
              ptr.node = ev.currentTarget
              ptr.x0 = ev.clientX; ptr.y0 = ev.clientY
              ptr.moved = false
            }
            function onWinMove(e) {
              if (ptr.mode === null) return
              if (!ptr.moved) {
                var dx = e.clientX - ptr.x0
                var dy = e.clientY - ptr.y0
                if (dx * dx + dy * dy < 36) return
                ptr.moved = true
                setDragMode(ptr.mode); setDragId(ptr.id)
                if (document.body) document.body.style.userSelect = 'none'
                // 从输入区拖起时先失焦,避免拖动中残留光标/选区
                if (document.activeElement && typeof document.activeElement.blur === 'function') {
                  try { document.activeElement.blur() } catch (e) { /* ignore */ }
                }
                if (ptr.node) {
                  var r = ptr.node.getBoundingClientRect()
                  ptr.offX = ptr.x0 - r.left
                  ptr.offY = ptr.y0 - r.top
                  ghostInit(ptr.node, e.clientX - ptr.offX, e.clientY - ptr.offY)
                }
              } else {
                ghostMove(e.clientX - ptr.offX, e.clientY - ptr.offY)
              }
              var t = e.target
              var el = (t && t.nodeType === 1) ? t : null
              while (el && el !== document.documentElement && !(el.getAttribute && el.getAttribute('data-uwblist'))) {
                el = el.parentElement
              }
              if (!el) { ptr.bookHint = null; ptr.entryHint = null; setBookHint(null); setEntryHint(null); return }
              var which = el.getAttribute('data-uwblist')
              if (which === 'books' && ptr.mode === 'book') {
                var hb = dropIndexFromPointer(el, e.clientY)
                ptr.bookHint = hb; ptr.entryHint = null
                setBookHint(hb); setEntryHint(null)
              } else if (which === 'entries' && ptr.mode === 'entry') {
                var he = dropIndexFromPointer(el, e.clientY)
                ptr.entryHint = he; ptr.bookHint = null
                setEntryHint(he); setBookHint(null)
              } else {
                ptr.bookHint = null; ptr.entryHint = null
                setBookHint(null); setEntryHint(null)
              }
            }
            function onWinUp() {
              if (ptr.mode === null) return
              var didDrag = ptr.moved
              if (didDrag) {
                if (ptr.mode === 'book' && ptr.bookHint !== null) moveBookTo(ptr.id, ptr.bookHint)
                if (ptr.mode === 'entry' && ptr.entryHint !== null) moveEntryTo(ptr.id, ptr.entryHint)
              }
              endDrag()
              if (didDrag) swallowNextClick()
            }

            var list = books || []
            var uids = sortedUids(raw || {})
            var onSet = {}
            ;(effective || []).forEach(function (id) { onSet[id] = true })
            var scopeTag = scope && scope.cwdKey ? scope.cwdKey.split('/').filter(Boolean).pop() || scope.cwdKey : null
            var status = err ? null
              : (busy ? '保存中…'
                : (books === null ? '加载中…'
                  : (scopeTag ? ('工作区 ' + scopeTag + ' · ' + list.length + ' 本 · 当前 ' + uids.length + ' 条') : ('编辑即自动保存'))))

            // 世界书列表子元素(整卡拖拽 + 启用状态指示)
            var bookChildren = []
            ;(books || []).forEach(function (b, bi) {
              if (dragMode === 'book' && bookHint !== null && bookHint === bi) {
                bookChildren.push(React.createElement('div', { key: 'bins-' + bi, style: sInsert }))
              }
              var dimmed = dragMode === 'book' && dragId === b.id
              var isOn = !!onSet[b.id]
              var isSel = b.id === sel
              var rowStyle = {
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '5px 8px', borderRadius: '6px', cursor: 'pointer',
                fontSize: '12px', overflow: 'hidden'
              }
              if (isOn) { rowStyle.background = C.success; rowStyle.color = '#fff' } else { rowStyle.color = C.label2 }
              if (isSel) rowStyle.boxShadow = 'inset 0 0 0 2px ' + C.label
              if (dimmed) rowStyle.opacity = 0.35
              bookChildren.push(React.createElement('div', {
                key: b.id,
                onMouseDown: function (ev) { rowDown('book', b.id, ev) },
                style: rowStyle,
                onClick: function () { if (ptr.mode === null) setSel(b.id) },
                onDoubleClick: function (ev) {
                  if (ptr.mode !== null) return
                  var t = ev.target
                  if (t && t.closest && t.closest('[data-uwb-dot]')) return // 圆点上双击由单击切换处理
                  toggleBook(b.id, !isOn)
                }
              },
                React.createElement('span', {
                  'data-uwb-dot': '1',
                  title: isOn ? '已启用(点击/双击切换)' : '未启用(点击/双击切换)',
                  style: sDot,
                  onMouseDown: function (ev) { ev.stopPropagation() },
                  onClick: function (ev) {
                    ev.stopPropagation()
                    if (ptr.mode === null) toggleBook(b.id, !isOn)
                  }
                }, isOn ? React.createElement('span', { style: sDotInner }) : null),
                React.createElement('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: '2px' }, title: b.id }, b.id),
                React.createElement('span', { style: { flexShrink: '0' } }, b.entryCount)
              ))
            })
            if (dragMode === 'book' && bookHint !== null && bookHint === (books || []).length) {
              bookChildren.push(React.createElement('div', { key: 'bins-end', style: sInsert }))
            }

            // 条目列表(ST 风格内联行:下拉/开关/标题输入/模式点/order/复制/删除 + 渐变展开)
            var entryChildren = []
            uids.forEach(function (uid, ei) {
              var v = rowView(raw, uid)
              var expanded = expand === uid
              if (dragMode === 'entry' && entryHint !== null && entryHint === ei) {
                entryChildren.push(React.createElement('div', { key: 'eins-' + ei, style: sInsert }))
              }
              var dimmedEntry = dragMode === 'entry' && dragId === uid
              var enabledNow = !v.disable
              var mountBody = expanded || !!openedSet[uid]
              // 实测高度动画:先 0(量取前)再过渡到内容真实高;展开/收回统一 500ms
              var hpx = expanded ? (sizes[uid] || 0) : 0
              var bodyWrap = {
                overflow: 'hidden',
                maxHeight: hpx + 'px',
                transition: 'max-height 350ms ease',
                pointerEvents: expanded ? 'auto' : 'none'
              }
              var knobStyle = { position: 'absolute', top: '2px', width: '14px', height: '14px', borderRadius: '7px', background: '#fff' }
              knobStyle.left = enabledNow ? '18px' : '2px'
              var switchStyle = {
                width: '34px', height: '18px', borderRadius: '9px', position: 'relative',
                flexShrink: '0', cursor: 'pointer', border: 'none', padding: '0'
              }
              if (enabledNow) {
                switchStyle.background = 'var(--dsw-alias-state-warn-primary)'
              } else {
                switchStyle.background = 'var(--dsw-alias-bg-layer-2)'
                switchStyle.boxShadow = 'inset 0 0 0 1px rgba(128,128,128,.5)'
                knobStyle.boxShadow = '0 0 0 1px rgba(128,128,128,.45)'
              }
              var rowBase = Object.assign({}, sRow)
              if (dimmedEntry) rowBase.opacity = 0.35
              else if (v.disable) rowBase.opacity = 0.6
              // 命中预览高亮:下一轮已确定插入的条目(浅绿叠加;仅当预览开启)
              if (settings && settings.hitPreview !== false && previewUids.indexOf(sel + '::' + uid) >= 0) {
                rowBase.background = 'rgba(120,220,150,0.22)'
                rowBase.boxShadow = 'inset 0 0 0 2px rgba(90,200,120,0.55)'
              }
              entryChildren.push(React.createElement('div', {
                key: uid,
                style: rowBase,
                onMouseDown: (expanded || rowGated(uid)) ? undefined : function (ev) { rowDown('entry', uid, ev) }
              },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', flexWrap: 'nowrap', minWidth: '0' } },
                  React.createElement('button', {
                    title: expanded ? '收起' : '展开',
                    onMouseDown: function (ev) { ev.stopPropagation() },
                    onClick: function (ev) {
                      ev.stopPropagation()
                      if (ptr.mode === null) {
                        if (expanded) { setExpand(null); return }
                        if (!openedSet[uid]) openedSet[uid] = 1
                        setExpand(uid)
                      }
                    },
                    style: { width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(128,128,128,.22)', color: 'var(--dsw-alias-label-primary)', border: 'none', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: '0' }
                  }, React.createElement('svg', {
                    width: 10, height: 6, viewBox: '0 0 10 6',
                    style: { transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease', display: 'block' }
                  }, React.createElement('path', {
                    d: 'M1 1 L5 5 L9 1',
                    fill: 'none', stroke: 'currentColor', strokeWidth: '1.6',
                    strokeLinecap: 'round', strokeLinejoin: 'round'
                  }))),
                  React.createElement('button', {
                    title: enabledNow ? '启用中(点击禁用)' : '已禁用(点击启用)',
                    onMouseDown: function (ev) { ev.stopPropagation() },
                    onClick: function (ev) { ev.stopPropagation(); if (ptr.mode === null) setEntryEnabled(uid, !enabledNow) },
                    style: switchStyle
                  }, React.createElement('span', { style: knobStyle })),
                  React.createElement('input', {
                    'data-uwb-gate': gateKey(uid, 'comment'),
                    style: Object.assign({
                      flex: '1', minWidth: '60px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: 600, padding: '2px', outline: 'none', minHeight: '16px'
                    }, isGated(uid, 'comment') ? { boxShadow: 'inset 0 0 0 1.5px #f59e0b', borderRadius: '4px' } : null, {
                      cursor: isGated(uid, 'comment') ? 'text' : 'pointer',
                      userSelect: isGated(uid, 'comment') ? 'text' : 'none',
                      caretColor: isGated(uid, 'comment') ? 'auto' : 'transparent'
                    }),
                    readOnly: !isGated(uid, 'comment'),
                    title: '标题(comment);单击进入编辑',
                    value: v.comment,
                    placeholder: '(无标题)',
                    onMouseDown: function (ev) { if (!isGated(uid, 'comment')) ev.preventDefault() }, // 非 gate:不聚焦出 I 光标;事件冒泡供拖行
                    onClick: function (ev) { ev.stopPropagation(); if (!isGated(uid, 'comment')) openGate(uid, 'comment') },
                    onChange: function (e) { if (isGated(uid, 'comment')) patchEntry(uid, { comment: e.target.value }) },
                    onBlur: function () { if (isGated(uid, 'comment')) closeGate(uid, 'comment'); enqueueSave(selRef, 0) },
                    onKeyDown: function (e) {
                      if (e.key === 'Enter' || e.key === 'Escape') {
                        if (e.key === 'Escape') e.stopPropagation() // 仅退出输入编辑,不关窗
                        e.preventDefault(); e.currentTarget.blur()
                      }
                    }
                  }),
                  React.createElement('span', { style: { fontSize: '10px', color: C.label2, flexShrink: '0', userSelect: 'none', whiteSpace: 'nowrap', minWidth: '26px', textAlign: 'right' } }, v.constant ? '常驻' : '触发'),
                  React.createElement('button', {
                    title: v.constant ? '常驻(蓝) → 点击切为触发' : '触发(绿) → 点击切为常驻',
                    onMouseDown: function (ev) { ev.stopPropagation() },
                    onClick: function (ev) { ev.stopPropagation(); if (ptr.mode === null) setEntryConstant(uid, !v.constant) },
                    style: { width: '13px', height: '13px', borderRadius: '50%', border: '1.5px solid rgba(128,128,128,.5)', background: v.constant ? '#3b82f6' : 'var(--dsw-alias-state-success-primary)', cursor: 'pointer', flexShrink: '0', padding: '0' }
                  }),
                  React.createElement('input', {
                    'data-uwb-gate': gateKey(uid, 'order'),
                    title: 'order(越小越靠前);单击进入编辑',
                    style: Object.assign({
                      width: '48px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: '11px', padding: '1px 3px', textAlign: 'center', flexShrink: '0'
                    }, isGated(uid, 'order') ? { boxShadow: 'inset 0 0 0 1.5px #f59e0b' } : null, {
                      cursor: isGated(uid, 'order') ? 'text' : 'pointer',
                      userSelect: isGated(uid, 'order') ? 'text' : 'none',
                      caretColor: isGated(uid, 'order') ? 'auto' : 'transparent'
                    }),
                    defaultValue: String(v.order),
                    key: uid + ':o:' + v.order + (isGated(uid, 'order') ? ':g' : ':n'),
                    readOnly: !isGated(uid, 'order'),
                    onMouseDown: function (ev) { if (!isGated(uid, 'order')) ev.preventDefault() },
                    onClick: function (ev) { ev.stopPropagation(); if (!isGated(uid, 'order')) openGate(uid, 'order') },
                    onBlur: function (e) {
                      var n = Number(e.target.value)
                      if (!Number.isNaN(n) && n !== v.order) patchEntry(uid, { order: n }, 'immediate')
                      if (isGated(uid, 'order')) closeGate(uid, 'order')
                    },
                    onKeyDown: function (e) {
                      if (e.key === 'Enter') { e.currentTarget.blur() }
                      if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.value = String(v.order); e.currentTarget.blur() }
                    }
                  }),
                  React.createElement('button', {
                    title: '复制本条目到其后',
                    onMouseDown: function (ev) { ev.stopPropagation() },
                    onClick: function (ev) { ev.stopPropagation(); if (ptr.mode === null) copyEntry(uid) },
                    style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', cursor: 'pointer', padding: '1px 5px', flexShrink: '0' }
                  }, '⧉'),
                  React.createElement('button', {
                    title: '删除条目',
                    onMouseDown: function (ev) { ev.stopPropagation() },
                    onClick: function (ev) { ev.stopPropagation(); if (ptr.mode === null) deleteEntry(uid) },
                    style: { border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: '4px', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', cursor: 'pointer', padding: '1px 5px', flexShrink: '0' }
                  }, '✕')
                ),
                mountBody
                  ? React.createElement('div', { 'data-uwb-body': uid, style: bodyWrap, onMouseDown: function (ev) { ev.stopPropagation() } },
                      React.createElement('div', { style: { padding: '0 8px 6px', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                        React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
                          React.createElement('div', { style: { flex: '1', minWidth: '0' } },
                            React.createElement('label', { style: sLabel }, '主要关键词（分号；隔断，常驻时忽略）'),
                            React.createElement('input', {
                              key: uid + ':kw:' + (v.keys || []).join('|'),
                              style: sInput,
                              defaultValue: (v.keys || []).join('; '),
                              onBlur: function (e) {
                                var ks = String(e.target.value).split(/[;；\n,，、]+/).map(function (x) { return x.trim() }).filter(Boolean)
                                patchEntry(uid, { key: ks }, 'immediate')
                              },
                              onKeyDown: function (e) {
                                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                                if (e.key === 'Escape') { e.currentTarget.blur() }
                              }
                            })
                          ),
                          React.createElement('div', { style: { width: '88px', flexShrink: '0' } },
                            React.createElement('label', { style: sLabel }, '逻辑'),
                            React.createElement('select', {
                              key: uid + ':lg:' + (v.selective ? '1' : '0') + ':' + v.selectiveLogic,
                              value: v.selectiveLogic,
                              onChange: function (e) {
                                patchEntry(uid, { selective: true, selectiveLogic: Number(e.target.value) }, 'immediate')
                              },
                              style: Object.assign({}, sInput, { padding: '3px 2px', cursor: 'pointer', width: '100%' }),
                              title: '可选过滤器与主要关键词的连接逻辑'
                            },
                              React.createElement('option', { value: 3 }, '与所有'),
                              React.createElement('option', { value: 0 }, '与任意'),
                              React.createElement('option', { value: 1 }, '非所有'),
                              React.createElement('option', { value: 2 }, '非任何')
                            )
                          ),
                          React.createElement('div', { style: { flex: '1', minWidth: '0' } },
                            React.createElement('label', { style: sLabel }, '可选过滤器'),
                            React.createElement('input', {
                              key: uid + ':ks:' + (v.secondaryKeys || []).join('|'),
                              style: sInput,
                              defaultValue: (v.secondaryKeys || []).join('; '),
                              onBlur: function (e) {
                                var ks = String(e.target.value).split(/[;；\n,，、]+/).map(function (x) { return x.trim() }).filter(Boolean)
                                patchEntry(uid, { keysecondary: ks, selective: ks.length > 0 }, 'immediate')
                              },
                              onKeyDown: function (e) {
                                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                                if (e.key === 'Escape') { e.currentTarget.blur() }
                              }
                            })
                          )
                        ),
                        React.createElement('label', { style: sLabel }, '内容'),
                        React.createElement('textarea', {
                          style: Object.assign({}, sTextarea, { minHeight: '90px' }),
                          value: v.content,
                          onChange: function (e) { patchEntry(uid, { content: e.target.value }) },
                          onBlur: function () { enqueueSave(sel, 0) } // 失焦立即落盘(内容区)
                        })
                      )
                    )
                  : null
              ))
            })
            if (dragMode === 'entry' && entryHint !== null && entryHint === uids.length) {
              entryChildren.push(React.createElement('div', { key: 'eins-end', style: sInsert }))
            }

            return React.createElement('div', { style: sMask, onClick: function () { if (ptr.mode === null) doClose() } },
              React.createElement('div', { style: sWin, onClick: function (ev) { ev.stopPropagation() } },
                React.createElement('div', { style: sHead },
                  React.createElement('span', { style: sTitle }, '通用世界书'),
                  React.createElement('span', { style: sStatus }, status || ''),
                  savedMsg ? React.createElement('span', { style: { fontSize: '11px', color: C.success, flexShrink: '0' } }, savedMsg) : null,
                  React.createElement('button', { style: sBtn, onClick: function () { doClose() } }, '关闭')
                ),
                err ? React.createElement('div', { style: sErr }, String(err)) : null,
                React.createElement('div', { style: sBody },
                  React.createElement('div', { style: sSide },
                    React.createElement('div', { style: sSideHead }, '世界书(' + list.length + ') · 整卡拖动排序'),
                    React.createElement('div', { 'data-uwblist': 'books', style: sBookList },
                      list.length === 0 && !(dragMode === 'book')
                        ? React.createElement('div', { style: sEmpty }, books === null ? '加载中…' : '(无世界书,点下方新建)')
                        : bookChildren),
                    React.createElement('div', { style: sToolCol },
                      React.createElement('div', { style: sToolRow },
                        React.createElement('button', { style: sToolBtn, onClick: newBook }, '新建'),
                        React.createElement('label', { style: sToolBtn }, '导入',
                          React.createElement('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: onImportFile })
                        ),
                        React.createElement('button', { style: sToolBtn, disabled: !sel, onClick: doExport }, '导出')
                      ),
                      React.createElement('div', { style: sToolRow },
                        React.createElement('button', { style: sToolBtn, disabled: !sel, onClick: renameBook }, '重命名'),
                        React.createElement('button', { style: sToolBtn, disabled: !sel, onClick: copyBook }, '复制'),
                        React.createElement('button', { style: sToolBtnDanger, disabled: !sel, onClick: deleteBook }, '删除')
                      )
                    ),
                    React.createElement('div', { style: { padding: '6px 8px', borderTop: '1px solid ' + C.border, display: 'flex' } },
                      React.createElement('button', {
                        style: Object.assign({}, sBtn, { flex: '1', margin: '0', textAlign: 'center' }),
                        title: '编辑注入时的通用头/尾提示词(包裹命中内容)',
                        onClick: openFmtModal
                      }, '头尾提示词')
                    )
                  ),
                  React.createElement('div', { style: sMain },
                    !sel
                      ? React.createElement('div', { style: sEmpty }, '选择或新建一本世界书')
                      : React.createElement(React.Fragment, null,
                          React.createElement('div', { style: sToolbar },
                            React.createElement('span', { style: sTitle }, sel),
                            React.createElement('span', { style: sBadge }, '整行拖动排序 = 重写 order'),
                            React.createElement('button', { style: sBtnBrand, onClick: addEntry }, '+ 添加条目'),
                            React.createElement('span', { style: Object.assign({}, sLabel, { display: 'inline', margin: '0 0 0 10px' }) }, '扫描深度'),
                            React.createElement('input', {
                              type: 'range', min: '1', max: '5', step: '1',
                              title: '多少条最新消息参与关键词匹配(深度 1=只扫 D0,默认 3=D0~D2)',
                              value: String(((settings && settings.scanDepth) || 3)),
                              onChange: onScanDepth,
                              style: { width: '70px', verticalAlign: 'middle', accentColor: 'var(--dsw-alias-brand-primary)' }
                            }),
                            React.createElement('span', { style: { fontSize: '11px', color: C.label2 } }, ((settings && settings.scanDepth) || 3)),
                            React.createElement('label', {
                              style: { margin: '0 0 0 10px', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: C.label2, cursor: 'pointer' },
                              title: '下一轮对话已确定插入的条目,用户输入可能激活更多条目'
                            },
                              React.createElement('input', {
                                type: 'checkbox',
                                checked: settings ? settings.hitPreview !== false : true,
                                onChange: onHitPreview,
                                style: { accentColor: 'var(--dsw-alias-state-success-primary)' }
                              }),
                              '命中预览')
                          ),
                          React.createElement('div', { 'data-uwblist': 'entries', style: sEntryList },
                            raw === null
                              ? React.createElement('div', { style: sEmpty }, '加载条目…')
                              : uids.length === 0 && !(dragMode === 'entry')
                                ? React.createElement('div', { style: sEmpty }, '(空世界书,点「+ 添加条目」)')
                                : entryChildren
                          )
                        )
                  )
                ),
                modal
                  ? React.createElement('div', { style: sModalMask, onClick: function () { if (modal.kind === 'choice') modalDone('cancel') } },
                      React.createElement('div', { style: modal.kind === 'format' ? Object.assign({}, sModalBox, { width: 'min(600px,92vw)' }) : sModalBox, onClick: function (ev) { ev.stopPropagation() } },
                        React.createElement('div', { style: sModalTitle }, modal.title),
                        modal.kind === 'prompt'
                          ? React.createElement('input', {
                              style: sInput,
                              value: promptVal,
                              autoFocus: true,
                              onChange: function (e) { setPromptVal(e.target.value) },
                              onKeyDown: function (e) { if (e.key === 'Enter') { modalDone(promptVal) } if (e.key === 'Escape') { modalDone(null) } }
                            })
                          : modal.kind === 'format'
                            ? React.createElement('div', null,
                                React.createElement('div', { style: sLabel }, '通用头部(拼在命中内容前)'),
                                React.createElement('textarea', {
                                  style: Object.assign({}, sTextarea, { minHeight: '70px' }),
                                  value: fmtHeader,
                                  autoFocus: true,
                                  placeholder: '例:以下是本轮可供参考的重要信息:',
                                  onChange: function (e) { setFmtHeader(e.target.value) }
                                }),
                                React.createElement('div', { style: sLabel }, '通用尾部(拼在命中内容后)'),
                                React.createElement('textarea', {
                                  style: Object.assign({}, sTextarea, { minHeight: '90px' }),
                                  value: fmtTail,
                                  placeholder: '例:参考信息结束。',
                                  onChange: function (e) { setFmtTail(e.target.value) }
                                }),
                                React.createElement('div', { style: Object.assign({}, sLabel, { color: C.label2 }) }, '在框内直接换行输入即可(无需转义)。保存后按「头部 + 命中内容 + 尾部」拼入,整块插在最新用户发言前。尾部末行常写「以下是用户本轮发言:」以引出紧随其后的真实发言。')
                              )
                            : null,
                        React.createElement('div', { style: sModalBtns },
                          modal.kind === 'prompt'
                            ? [
                                React.createElement('button', { key: 'ok', style: sBtnBrand, onClick: function () { modalDone(promptVal) } }, '确定'),
                                React.createElement('button', { key: 'no', style: sBtn, onClick: function () { modalDone(null) } }, '取消')
                              ]
                            : modal.kind === 'format'
                              ? [
                                  React.createElement('button', { key: 'reset', style: sBtn, onClick: fmtRestoreDefaults }, '恢复默认'),
                                  React.createElement('button', { key: 'cancel', style: sBtn, onClick: function () { modalDone(null) } }, '取消'),
                                  React.createElement('button', { key: 'save', style: sBtnBrand, onClick: fmtSave }, '保存')
                                ]
                              : modal.buttons.map(function (btn) {
                                  return React.createElement('button', {
                                    key: btn.value + ':' + btn.label,
                                    style: btn.danger ? sBtnDanger : (btn.primary ? sBtnBrand : sBtn),
                                    onClick: function () { modalDone(btn.value) }
                                  }, btn.label)
                                })
                        )
                      )
                    )
                  : null
              )
            )
          })
        })
      }, 'uwb: shell.overlay')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

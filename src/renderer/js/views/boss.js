import { $, $$, el, clear, on, esc, clamp, nextFrame } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, call } from '../lib/toast.js';

/**
 * 摸鱼模式（渲染层）。
 *
 * 三种形态：
 *   square —— 正方形迷你框：只有文字、无选项、无程序边框（主推）
 *   normal —— 完整伪装界面（Word / Excel / VS Code / 邮件）
 *   ghost  —— 隐身：窗口近乎透明
 *
 * 切换性能关键：所有伪装界面在初始化时就预生成好 DOM，
 * 切换只改 CSS 可见性，不触发任何网络请求或重排，保证 <150ms 呈现。
 */

const FAKE_MODES = [
  { key: 'fake-word', label: 'Word 文档', desc: '会议纪要为底，最不引人注意' },
  { key: 'fake-excel', label: 'Excel 表格', desc: '带行列号与公式栏的真实观感' },
  { key: 'fake-code', label: 'VS Code', desc: '带语法高亮的代码编辑器' },
  { key: 'fake-mail', label: 'Outlook 邮件', desc: '三栏邮件客户端布局' },
  { key: 'mini-text', label: '纯文字迷你框', desc: '只有一个正方形的正文，最隐蔽' },
];

export class BossView {
  constructor({ state, bus, app }) {
    this.state = state;
    this.bus = bus;
    this.app = app;
    this.api = window.firmament;
    this.isActive = false;
    this.style = 'square';
    this.mode = 'fake-word';
    this._built = false;
  }

  async init() {
    const st = await call(this.api.boss.state(), { silent: true });
    if (st) {
      this.mode = st.mode || 'fake-word';
      this.style = st.style || 'square';
      this.isActive = !!st.active;
      this.hotkeyOk = st.hotkeyOk !== false;
      this.hotkeyError = st.hotkeyError || '';
    }

    this.buildFakeContent();
    this.bindEvents();
    this.bus.on('route', () => {
      if (this.isActive) this.renderMini();
    });
  }

  /* ============================ 预生成伪装内容 ============================ */

  buildFakeContent() {
    if (this._built) return;
    this._built = true;

    this.buildWordDoc();
    this.buildExcelSheet();
    this.buildCodeFile();
    this.buildMailBox();
  }

  /** 仿 Word：一份看起来像样的会议纪要 */
  buildWordDoc() {
    const host = $('#fakeWordPage');
    if (!host) return;
    const paras = [
      ['会议时间', '2026年9月18日 14:00 - 15:30'],
      ['会议地点', '总部 3 号楼 12 层第二会议室'],
      ['参会人员', '张明、李伟、王芳、陈晓东、刘婷'],
      ['记录人', '刘婷'],
    ];

    const head = paras.map(([k, v]) =>
      `<p class="doc-no">${esc(k)}：<span style="font-weight:400">${esc(v)}</span></p>`
    ).join('');

    host.innerHTML = `
      <h1>第三季度项目推进情况汇报会 会议纪要</h1>
      ${head}
      <p class="doc-no" style="margin-top:20px">一、本季度工作回顾</p>
      <p>本季度各部门围绕年度经营目标，稳步推进各项重点工作。技术中心完成核心系统重构，接口平均响应时间由 480ms 下降至 132ms，系统稳定性显著提升。市场部在华东、华南两个重点区域完成渠道梳理，新增合作方 14 家。</p>
      <p>财务数据显示，本季度营业收入较上季度增长 12.4%，毛利率保持在合理区间。成本控制方面，通过供应链优化与集中采购，采购成本同比下降 6.8%。</p>
      <p class="doc-no">二、存在的问题</p>
      <p>部分项目节点较原计划滞后，主要原因是需求变更频繁导致返工。跨部门协作流程仍存在信息传递不及时的情况，需要在下一阶段重点改进。</p>
      <p class="doc-no">三、下一阶段工作安排</p>
      <p>1. 技术中心牵头，于 10 月中旬前完成新版管理后台的联调测试工作，并同步输出部署方案与回滚预案。</p>
      <p>2. 市场部继续推进区域渠道建设，重点跟进已签约合作方的落地情况，形成月度跟踪台账。</p>
      <p>3. 财务部配合完成年度预算的中期复盘，对偏差较大的科目逐项说明原因并提出调整建议。</p>
      <p class="doc-no">四、会议要求</p>
      <p>各部门负责人需在本周五下班前，将本部门的细化执行方案报送至项目管理办公室，由办公室汇总后提交总经理审阅。后续将建立双周例会机制，跟踪各项任务的落实情况。</p>
    `;
  }

  /** 仿 Excel：带行列号与数据的表格 */
  buildExcelSheet() {
    const host = $('#fakeExcelSheet');
    if (!host) return;

    const cols = ['A', 'B', 'C', 'D', 'E', 'F'];
    const headers = ['项目名称', '一季度', '二季度', '三季度', '同比增幅', '负责人'];
    const rows = [
      ['华东区域收入', '2,845,600', '3,102,450', '3,486,120', '12.4%', '张明'],
      ['华南区域收入', '1,932,400', '2,088,300', '2,341,700', '12.1%', '李伟'],
      ['华北区域收入', '2,105,800', '2,240,600', '2,398,450', '7.0%', '王芳'],
      ['西南区域收入', '986,300', '1,102,750', '1,284,530', '16.5%', '陈晓东'],
      ['线上渠道收入', '3,420,900', '3,886,200', '4,512,800', '16.1%', '刘婷'],
      ['产品采购成本', '-1,845,200', '-1,902,600', '-1,978,400', '4.0%', '赵强'],
      ['物流配送成本', '-486,500', '-502,300', '-518,900', '3.3%', '孙丽'],
      ['人力成本', '-2,340,000', '-2,415,000', '-2,486,000', '2.9%', '周涛'],
      ['市场推广费用', '-680,400', '-742,100', '-798,600', '7.6%', '吴敏'],
      ['营业利润', '1,924,500', '2,266,700', '2,758,300', '21.7%', '张明'],
      ['毛利率', '28.6%', '29.4%', '31.2%', '1.8pp', '—'],
      ['净利率', '12.4%', '13.1%', '14.6%', '1.5pp', '—'],
    ];

    const thead = `<thead><tr><th class="row-head"></th>${cols.map((c, i) =>
      `<th>${c}<br><span style="font-weight:400;font-size:10px">${esc(headers[i])}</span></th>`
    ).join('')}</tr></thead>`;

    const tbody = rows.map((r, i) => {
      const num = String(i + 2);
      return `<tr><td class="row-head">${num}</td>${r.map((c, j) =>
        `<td class="${j >= 1 && j <= 4 ? 'cell-num' : ''}">${esc(c)}</td>`
      ).join('')}</tr>`;
    }).join('');

    host.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>`;

    const f = $('#fakeExcelFormula');
    if (f) f.textContent = '=SUM(B2:D2)/COUNT(B2:D2)';
  }

  /** 仿 VS Code：带语法高亮的 TypeScript */
  buildCodeFile() {
    const host = $('#fakeCodeArea');
    if (!host) return;

    const lines = [
      '<span class="tk-cm">// 用户服务：查询与权限校验</span>',
      '<span class="tk-kw">import</span> { <span class="tk-typ">PrismaClient</span> } <span class="tk-kw">from</span> <span class="tk-str">"@prisma/client"</span>;',
      '<span class="tk-kw">import</span> { <span class="tk-fn">verifyToken</span> } <span class="tk-kw">from</span> <span class="tk-str">"./auth"</span>;',
      '',
      '<span class="tk-kw">const</span> <span class="tk-var">prisma</span> = <span class="tk-kw">new</span> <span class="tk-typ">PrismaClient</span>();',
      '',
      '<span class="tk-kw">export async function</span> <span class="tk-fn">getUserProfile</span>(<span class="tk-var">token</span>: <span class="tk-typ">string</span>) {',
      '  <span class="tk-kw">const</span> <span class="tk-var">payload</span> = <span class="tk-kw">await</span> <span class="tk-fn">verifyToken</span>(<span class="tk-var">token</span>);',
      '  <span class="tk-kw">if</span> (!<span class="tk-var">payload</span>) {',
      '    <span class="tk-kw">throw new</span> <span class="tk-typ">Error</span>(<span class="tk-str">"unauthorized"</span>);',
      '  }',
      '',
      '  <span class="tk-kw">const</span> <span class="tk-var">user</span> = <span class="tk-kw">await</span> <span class="tk-var">prisma</span>.<span class="tk-var">user</span>.<span class="tk-fn">findUnique</span>({',
      '    <span class="tk-var">where</span>: { <span class="tk-var">id</span>: <span class="tk-var">payload</span>.<span class="tk-var">sub</span> },',
      '    <span class="tk-var">select</span>: {',
      '      <span class="tk-var">id</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">name</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">email</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">department</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">roles</span>: <span class="tk-kw">true</span>,',
      '    },',
      '  });',
      '',
      '  <span class="tk-kw">return</span> <span class="tk-var">user</span>;',
      '}',
      '',
      '<span class="tk-kw">export async function</span> <span class="tk-fn">listOrders</span>(<span class="tk-var">userId</span>: <span class="tk-typ">string</span>, <span class="tk-var">page</span> = <span class="tk-num">1</span>) {',
      '  <span class="tk-kw">const</span> <span class="tk-var">size</span> = <span class="tk-num">20</span>;',
      '  <span class="tk-kw">const</span> <span class="tk-var">where</span> = { <span class="tk-var">userId</span>, <span class="tk-var">deletedAt</span>: <span class="tk-kw">null</span> };',
      '',
      '  <span class="tk-kw">const</span> [<span class="tk-var">items</span>, <span class="tk-var">total</span>] = <span class="tk-kw">await</span> <span class="tk-var">prisma</span>.<span class="tk-fn">$transaction</span>([',
      '    <span class="tk-var">prisma</span>.<span class="tk-var">order</span>.<span class="tk-fn">findMany</span>({',
      '      <span class="tk-var">where</span>,',
      '      <span class="tk-var">orderBy</span>: { <span class="tk-var">createdAt</span>: <span class="tk-str">"desc"</span> },',
      '      <span class="tk-var">skip</span>: (<span class="tk-var">page</span> - <span class="tk-num">1</span>) * <span class="tk-var">size</span>,',
      '      <span class="tk-var">take</span>: <span class="tk-var">size</span>,',
      '    }),',
      '    <span class="tk-var">prisma</span>.<span class="tk-var">order</span>.<span class="tk-fn">count</span>({ <span class="tk-var">where</span> }),',
      '  ]);',
      '',
      '  <span class="tk-kw">return</span> { <span class="tk-var">items</span>, <span class="tk-var">total</span>, <span class="tk-var">page</span>, <span class="tk-var">size</span> };',
      '}',
    ];

    const frag = document.createDocumentFragment();
    lines.forEach((html, i) => {
      const line = el('div.code-line', {}, [
        el('span.code-line__no', { text: String(i + 1) }),
        el('span.code-line__txt', {
          html: html + (i === 41 ? '<span class="cursor"></span>' : ''),
        }),
      ]);
      frag.appendChild(line);
    });
    host.appendChild(frag);
  }

  /** 仿 Outlook：邮件三栏 */
  buildMailBox() {
    const listHost = $('#fakeMailList');
    const viewHost = $('#fakeMailView');
    if (!listHost || !viewHost) return;

    const mails = [
      { from: '系统通知中心', subj: '【重要】2026年度绩效考核工作启动通知', pre: '各位同事：根据公司年度工作安排，本年度绩效考核工作将于10月8日正式启动…', time: '09:42' },
      { from: '张明', subj: '关于Q3经营分析报告的数据口径说明', pre: '附件中的数据我已经按照财务口径重新核对了一遍，其中线上渠道部分…', time: '09:15' },
      { from: '项目管理办公室', subj: '第三季度项目进度跟踪表（更新至9月18日）', pre: '现将各单位报送的项目进度汇总如下，请各部门对照计划节点自查…', time: '昨天' },
      { from: 'IT服务台', subj: '办公网络设备维护通知', pre: '为保障办公网络稳定运行，信息中心计划于本周六凌晨进行设备巡检…', time: '昨天' },
      { from: '李伟', subj: '华东区域渠道合作协议（最终版）', pre: '协议文本已经过法务审核，主要修改点集中在结算周期与违约责任条款…', time: '周三' },
      { from: '人力资源部', subj: '9月社保公积金缴纳基数调整说明', pre: '根据最新政策要求，自本月起社保缴纳基数上下限进行调整…', time: '周三' },
      { from: '财务部', subj: '9月费用报销截止时间提醒', pre: '本月费用报销单据请于9月25日17:00前提交至共享中心，逾期将顺延…', time: '周二' },
      { from: '王芳', subj: '客户拜访纪要（9月16日）', pre: '本次拜访主要沟通了明年的合作规模与交付节奏，客户对交付周期…', time: '周二' },
    ];

    clear(listHost);
    mails.forEach((m, i) => {
      const row = el('div.mail-row', { class: i === 1 ? 'is-on' : '' }, [
        el('div.mail-row__from', { text: m.from }),
        el('div.mail-row__subj', { text: m.subj }),
      ]);
      listHost.appendChild(row);
    });

    viewHost.innerHTML = `
      <h2>关于Q3经营分析报告的数据口径说明</h2>
      <div class="mail-view__meta">
        发件人：张明 &nbsp;·&nbsp; 收件人：经营分析组 &nbsp;·&nbsp; 时间：今天 09:15
      </div>
      <p>各位：</p>
      <p>附件中的数据我已经按照财务口径重新核对了一遍，其中线上渠道部分的统计范围有所调整，把退款订单从收入中扣除后再计算，因此与市场部之前提供的数字会有差异。建议统一采用财务口径，避免后续汇报时出现两套数字。</p>
      <p>另外，同比增幅那一列的计算基数是去年同期数据，需要提醒的是去年同期有一个大额一次性订单，如果剔除这个因素，实际可比增幅大约在 9.6% 左右。这一点在汇报时最好能说明一下，避免引起不必要的追问。</p>
      <p>成本科目我按采购、物流、人力、推广四类做了归集，其中采购成本下降主要是因为集中采购议价，物流成本的上升与订单量增长基本匹配，属于正常范围。</p>
      <p>如果口径上有其他意见，请在今天下班前反馈给我，明天上午我会把最终版本提交给总经理办公室。</p>
      <p style="color:#605e5c">张明<br>财务分析岗<br>2026-09-19</p>
    `;
  }

  /* ============================ 事件 ============================ */

  bindEvents() {
    this.bindMiniDrag();
    this.bindMiniTouch();
    this.bindFakeExit();
    this.bindKeyboardExit();

    // 主进程推送的状态同步
    this.api.boss.onToggle && this.api.boss.onToggle((st) => this.syncFromMain(st));
  }

  /**
   * 迷你框：自定义拖拽 + 双击退出。
   *
   * ⚠ 这里刻意不用 CSS 的 -webkit-app-region: drag。
   *   那个方案有两个坑：
   *     1. 拖拽区会吞掉鼠标事件，内部的 dblclick 根本不触发 ——
   *        用户"双击顶部"想退出，结果毫无反应；
   *     2. Windows 会把「双击拖拽区」解释为「最大化窗口」，
   *        于是迷你框一下子铺满全屏 —— 正是用户反馈的"竟然全屏了"。
   *
   *   改成自己监听 mousedown/mousemove 并把位移发给主进程移动窗口后，
   *   双击可以被正常识别；再配合主进程 setMaximizable(false)，
   *   双保险确保不会再误最大化。
   */
  bindMiniDrag() {
    const mini = $('#bossMini');
    if (!mini) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('#bossMiniClose')) return;   // 点关闭按钮不算拖拽
      dragging = true;
      moved = 0;
      startX = lastX = e.screenX;
      startY = lastY = e.screenY;
      document.body.classList.add('is-dragging-mini');
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 3) {
        // screenX/Y 是屏幕坐标，与窗口位移同源，不需要再换算 DPI
        this.api.app.moveBy(dx, dy);
      }
    };

    const onUp = () => {
      if (!dragging) return;
      const wasDrag = moved > 5;
      dragging = false;
      document.body.classList.remove('is-dragging-mini');
      // 拖拽结束后短时间内忽略点击，避免"拖完手一松"被当成翻页点击
      if (wasDrag) this._suppressMiniClick = Date.now() + 180;
    };

    mini.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // 双击顶部区域退出（判定区域放宽到整个迷你框的上 40%，
    // 因为 340px 的框里"顶部"对用户来说是个模糊概念）
    mini.addEventListener('dblclick', (e) => {
      if (e.target.closest('#bossMiniClose')) return;
      const rect = mini.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (y <= rect.height * 0.4) {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
      }
    });
  }

  /** 迷你框内的点击翻页、滚轮、右键退出 */
  bindMiniTouch() {
    const body = $('#bossMiniBody');
    if (!body) return;

    body.addEventListener('click', (e) => {
      if (e.target.closest('#bossMiniClose')) return;
      if (this._suppressMiniClick && Date.now() < this._suppressMiniClick) return;
      const rect = body.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.32) this.miniPrev();
      else if (x > rect.width * 0.68) this.miniNext();
    });

    // 滚轮：**按行**滚动，一次向下两行（用户要求）。
    //
    // ⚠ 不能用原来的 miniNext/miniPrev —— 那是"整屏翻一页"，
    //   400px 的小框里一次跳走整屏，读者完全跟不上。
    //   这里改成按行位移：一次滚轮 notch（deltaY≈100）走两行。
    body.addEventListener('wheel', (e) => {
      e.preventDefault();
      const raw = Number(e.deltaY) || 0;
      if (!raw) return;
      // 认准方向即可，忽略驱动的力度差异：一个方向键帽 = 固定两行
      this.miniScrollLines(raw > 0 ? 2 : -2);
    }, { passive: false });

    // 右键退出 —— 桌面软件的通用直觉
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.exit();
    });
  }

  /** 伪装界面双击顶部栏退出 */
  bindFakeExit() {
    $$('.fake').forEach((f) => {
      const chrome = f.querySelector('.fake__chrome, .ribbon, .fake__toolbar');
      if (chrome) {
        chrome.addEventListener('dblclick', (e) => {
          e.preventDefault();
          this.exit();
        });
      }
    });
  }

  /** 键盘兜底 + 退出按钮 */
  bindKeyboardExit() {
    // 显式退出按钮（可发现性最好的一条路）
    const closeBtn = $('#bossMiniClose');
    if (closeBtn) {
      closeBtn.innerHTML = icon('x', 11);
      closeBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.exit();
      });
    }

    // 窗口若拿到焦点（例如用户点了一下迷你框），Esc 就能直接退出
    document.addEventListener('keydown', (e) => {
      if (!this.isActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
      }
    }, true);
  }

  /* ============================ 进入 / 退出 ============================ */

  async enter(opts) {
    const o = opts || {};
    const mode = o.mode || this.mode;
    const style = o.style || this.style;

    this.mode = mode;
    this.style = style;

    // ⚠ 窗口形状由**主进程**根据 store.settings.bossStyle/bossMode 决定，
    //   渲染层的 this.mode/this.style 只是本地缓存。若只改本地缓存就调 toggle，
    //   主进程仍按旧设置调整窗口 —— 会出现「界面已切成迷你框、窗口却没变方」
    //   这种表里不一的状态。因此显式传参时必须先把设置同步给主进程。
    if (o.mode !== undefined || o.style !== undefined) {
      await call(this.api.boss.apply({ mode, style }), { silent: true });
    }

    // 先把渲染层的可见性准备好，再让主进程改窗口形态，
    // 这样用户看到的顺序是「内容先就位 → 窗口变成正方形」，不会闪空白
    const effectiveStyle = mode === 'mini-text' ? 'square' : style;
    await this.applyVisibility(true, mode, effectiveStyle);

    const st = await call(this.api.boss.toggle(true), { silent: true });
    if (st) this.syncFromMain(st);
    return st;
  }

  async exit() {
    await this.applyVisibility(false, this.mode, this.style);
    const st = await call(this.api.boss.toggle(false), { silent: true });
    if (st) this.syncFromMain(st);
    this.app.reader && this.app.reader.showUI(true);
    toast('已恢复阅读', { duration: 1400 });
  }

  /** 依据形态与模式设置可见性 */
  async applyVisibility(on, mode, style) {
    document.body.classList.remove('is-boss-square', 'is-boss-ghost', 'is-boss-normal');
    $$('.fake').forEach((f) => f.classList.remove('is-on'));
    $('#bossMini').classList.add('is-hidden');

    if (!on) {
      document.body.removeAttribute('data-fake-active');
      document.body.classList.add('is-boss-off');
      return;
    }
    document.body.classList.remove('is-boss-off');

    if (mode === 'mini-text' || style === 'square') {
      document.body.classList.add('is-boss-square');
      $('#bossMini').classList.remove('is-hidden');
      this.renderMini();
      document.body.setAttribute('data-fake-active', 'true');
    } else if (style === 'ghost') {
      document.body.classList.add('is-boss-ghost');
      document.body.setAttribute('data-fake-active', 'true');
    } else {
      document.body.classList.add('is-boss-normal');
      const node = $(`#${cssId(mode)}`);
      if (node) node.classList.add('is-on');
      else {
        document.body.classList.add('is-boss-square');
        $('#bossMini').classList.remove('is-hidden');
        this.renderMini();
      }
      document.body.setAttribute('data-fake-active', 'true');
    }
    await nextFrame();
  }

  /** 与主进程状态对齐 */
  syncFromMain(st) {
    if (!st) return;
    this.isActive = !!st.active;
    if (st.mode) this.mode = st.mode;
    if (st.style) this.style = st.style;
    this.hotkeyOk = st.hotkeyOk !== false;
    this.hotkeyError = st.hotkeyError || '';

    if (this.isActive) {
      const effectiveStyle = this.mode === 'mini-text' ? 'square' : this.style;
      this.applyVisibility(true, this.mode, effectiveStyle);
    } else {
      this.applyVisibility(false, this.mode, this.style);
    }

    const btn = $('#rbtnBoss');
    if (btn) btn.classList.toggle('is-on', this.isActive);
  }

  /* ============================ 迷你框内容 ============================ */

  /**
   * 从章节 HTML 抽取「按段落切分」的纯文本。
   * 直接剥标签会把相邻段落粘成一句（</p><p> 之间没有任何分隔符），
   * 所以这里先把段落边界显式转成换行，再逐段处理。
   */
  extractParagraphs(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|blockquote|li|figure|figcaption)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 计算迷你框一行能放多少字、总共能放几行 */
  miniCapacity() {
    const boxW = this.state.settings.miniBoxSize || 300;
    // 与 .boss-mini__text 的字号保持同步（0.9 倍正文），否则容量算不准，
    // 会出现「填不满一屏」或「溢出被裁掉」两种情况
    const fontPx = (this.state.settings.fontSize || 19) * 0.9;
    const lineH = fontPx * 1.72;

    const usableW = boxW - 40;   // 左右 padding 20*2
    const usableH = boxW - 42;   // 上下 padding 22+20
    const charsPerLine = Math.max(6, Math.floor(usableW / fontPx));
    const lines = Math.max(3, Math.floor(usableH / lineH));
    // lineH 一并返回：滚轮要按"行"步进，必须知道一行多高
    return { charsPerLine, lines, lineH, capacity: charsPerLine * lines };
  }

  /** 渲染正方形迷你框内容：只有文字，无任何选项 */
  renderMini() {
    const host = $('#bossMiniText');
    if (!host) return;
    const reader = this.app.reader;

    if (!reader || !reader.chapter) {
      host.innerHTML = '<p>还没有打开任何书籍。</p><p>先在书架中选择一本，再进入摸鱼模式。</p>';
      return;
    }

    const paras = this.extractParagraphs(reader.chapter.html);
    if (!paras.length) {
      host.innerHTML = '<p>（本章暂无可显示的内容）</p>';
      return;
    }

    const { charsPerLine, capacity } = this.miniCapacity();
    const ratio = clamp(reader.ratio || 0, 0, 1);

    // 定位到当前比例对应的**字符偏移**。
    //
    // ⚠ 关键：不能只按"段落起点"切，否则滚轮按行滚动会失效 ——
    //   小说一段常有 200+ 字，而滚一次只走两行（约 30 字），
    //   段落起点没变 → 渲染结果完全相同 → 画面纹丝不动，
    //   用户会以为"迷你框滚轮坏了"。
    //   所以这里以字符为单位，允许从段落中间开始显示。
    const totalChars = paras.reduce((a, p) => a + p.length, 0);
    const targetChar = Math.floor(totalChars * ratio);
    let acc = 0;
    let startPara = 0;
    let offsetInPara = 0;
    for (let i = 0; i < paras.length; i++) {
      if (acc + paras[i].length > targetChar) {
        startPara = i;
        offsetInPara = targetChar - acc;
        break;
      }
      acc += paras[i].length;
      startPara = i;
      offsetInPara = 0;
    }
    // 到章末时从最后一段开始，避免空白
    if (ratio >= 0.995) { startPara = Math.max(0, paras.length - 1); offsetInPara = 0; }

    // ⚠ 把段内偏移对齐到整行。
    //   中文（CJK）码位一律等宽，每行恰好 charsPerLine 个字，
    //   所以按 charsPerLine 取整后，画面位移就是**精确的整数行**——
    //   滚两行就是视觉上的两行，不会出现半行的抖动。
    if (offsetInPara > 0) {
      offsetInPara = Math.floor(offsetInPara / charsPerLine) * charsPerLine;
    }

    // 从该段起向下填满容量（多取一段作余量，避免末行露白）
    const picked = [];
    let used = 0;
    for (let i = startPara; i < paras.length; i++) {
      const p = paras[i];
      if (used > 0 && used + p.length > capacity * 1.5) break;
      picked.push(p);
      used += p.length;
      if (used >= capacity) break;
    }
    if (!picked.length) picked.push(paras[startPara]);

    // ⚠ 用「负上边距平移」而不是裁掉文字。
    //
    //   若把首段已读的部分 slice 掉，段落会重新换行 ——
    //   视觉上像"重新排版"而不是"滚动"，且首行缩进会错位。
    //   改成整段渲染再向上平移 N 行（N 为按行对齐后的偏移），
    //   换行位置与真实排版完全一致，看起来就是平滑滚动。
    const { lineH } = this.miniCapacity();
    const offsetLines = offsetInPara > 0 ? offsetInPara / charsPerLine : 0;
    const shiftPx = Math.round(offsetLines * lineH);

    host.innerHTML = picked.map((p) => `<p>${esc(p)}</p>`).join('');
    if (shiftPx > 0) host.style.marginTop = '-' + shiftPx + 'px';
    else host.style.marginTop = '';

    // 顶部进度线 + 悬停提示
    const overall = reader.toc && reader.toc.length
      ? ((reader.chapterIndex + ratio) / reader.toc.length) * 100
      : 0;
    $('#bossMiniLine').style.width = clamp(overall, 0, 100) + '%';
    $('#bossMiniHint').textContent = `第 ${reader.chapterIndex + 1} 章 ｜ 点两侧翻页 ｜ Esc 或右上角 × 退出`;
  }

  /**
   * 把新的章内比例写回阅读引擎并刷新迷你框。
   * 抽出来是因为"整屏翻页"和"滚轮按行滚动"走的是同一条写回路径。
   */
  applyMiniRatio(next) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const r = clamp(next, 0, 1);
    reader.ratio = r;

    // 同步真实阅读位置，退出后能接上
    if (this.state.settings.pageMode === 'scroll') reader.scroller.setRatio(r, false);
    else reader.paginator.setRatio(r);

    this.renderMini();
    reader.updateProgressUI();
    reader.scheduleSave();
  }

  /** 迷你框整屏翻页：按容量步进，而不是整章翻 */
  miniStep(dir) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const paras = this.extractParagraphs(reader.chapter.html);
    const totalChars = paras.reduce((a, p) => a + p.length, 0) || 1;
    const { capacity } = this.miniCapacity();
    const step = capacity / totalChars;
    this.applyMiniRatio((reader.ratio || 0) + dir * step);
  }

  /**
   * 迷你框按「行」滚动（滚轮用）。
   *
   * ⚠ 为什么不能沿用整屏翻页：迷你框只有约 300px，
   *   一次滚轮若按容量步进就跳走整屏文字，读者根本接不上；
   *   按行位移才是滚轮该有的手感。
   *
   * 换算方式：一行的高度为 lineH，先用「每行字数」把像素折算成
   * 字符数，再除以全章总字数得到比例步长 —— 这样即使字号/框大小
   * 变了，滚一行也始终约等于视觉上的一行。
   */
  miniScrollLines(lines) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const paras = this.extractParagraphs(reader.chapter.html);
    const totalChars = paras.reduce((a, p) => a + p.length, 0) || 1;
    const { charsPerLine } = this.miniCapacity();

    // lines 行 ≈ lines 行 × 每行字数 个字符
    const chars = Math.abs(lines) * charsPerLine;
    const step = chars / totalChars;
    this.applyMiniRatio((reader.ratio || 0) + (lines > 0 ? step : -step));
  }

  miniNext() { this.miniStep(1); }
  miniPrev() { this.miniStep(-1); }

  /* ============================ 设置页辅助 ============================ */

  static FAKE_MODES = FAKE_MODES;
}

/** 伪装模式 key → DOM 元素 id（HTML 里用的是 camelCase id） */
const FAKE_DOM_ID = {
  'fake-word': 'fakeWord',
  'fake-excel': 'fakeExcel',
  'fake-code': 'fakeCode',
  'fake-mail': 'fakeMail',
};

function cssId(mode) {
  return FAKE_DOM_ID[mode] || String(mode || '').replace(/[^a-zA-Z0-9_-]/g, '');
}
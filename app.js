const subjects = ['生理', '病理', '内科', '外科', '生化'];
let mnemonics = [];
let date = todayKey();
let dailyCount = 5;
let mode = 'mixed';
let selectedSubjects = [...subjects];
let study = {};
let dailyItems = [];
let round = 0;
let current = 0;
let stage = 0;

const el = (id) => document.getElementById(id);

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function bytesFromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptQuestionBank(password) {
  const response = await fetch('./mnemonics.enc.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('题库文件加载失败');
  const payload = await response.json();
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: bytesFromBase64(payload.salt),
      iterations: payload.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesFromBase64(payload.iv) },
    key,
    bytesFromBase64(payload.ciphertext),
  );
  const stream = new Blob([plaintext]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressed = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(decompressed));
}

function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffled(items, seedText) {
  let seed = hashSeed(seedText) || 1;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function storageKey(targetDate, count, targetMode, allowed, targetRound) {
  return `med-daily-${targetDate}-${count}-${targetMode}-${[...allowed].sort().join('.')}-r${targetRound}`;
}

function makeDailySet(count, targetMode, allowed, targetRound = 0, excludedIds = []) {
  const eligible = mnemonics.filter((item) => allowed.includes(item.subject) && !excludedIds.includes(item.id));
  const seed = `${date}-r${targetRound}-${allowed.join('.')}`;
  const due = eligible.filter((item) => study[item.id]?.result === 'review' && study[item.id]?.lastDate !== date);
  const unseen = eligible.filter((item) => !study[item.id]);
  const seen = eligible.filter((item) => study[item.id]);
  const pool = [...shuffled(due, `${seed}-due`), ...shuffled(unseen, `${seed}-new`), ...shuffled(seen, `${seed}-seen`)];
  const unique = [...new Map(pool.map((item) => [item.id, item])).values()];

  if (targetMode === 'balanced') {
    const buckets = Object.fromEntries(allowed.map((subject) => [subject, unique.filter((item) => item.subject === subject)]));
    const result = [];
    let bucketRound = 0;
    while (result.length < count) {
      let added = false;
      for (const subject of allowed) {
        const item = buckets[subject]?.[bucketRound];
        if (item && result.length < count) {
          result.push(item);
          added = true;
        }
      }
      if (!added) break;
      bucketRound += 1;
    }
    return result;
  }

  const maxPerSubject = allowed.length >= 3 ? Math.max(2, Math.ceil(count * 0.4)) : count;
  const tally = Object.fromEntries(subjects.map((subject) => [subject, 0]));
  const result = [];
  for (const item of unique) {
    if (tally[item.subject] >= maxPerSubject) continue;
    result.push(item);
    tally[item.subject] += 1;
    if (result.length === count) break;
  }
  return result;
}

function restoreState() {
  dailyCount = Math.min(20, Math.max(1, Number(localStorage.getItem('med-daily-count')) || 5));
  mode = localStorage.getItem('med-study-mode') === 'balanced' ? 'balanced' : 'mixed';
  try {
    const savedSubjects = JSON.parse(localStorage.getItem('med-study-subjects') || '[]');
    selectedSubjects = subjects.filter((subject) => savedSubjects.includes(subject));
    if (!selectedSubjects.length) selectedSubjects = [...subjects];
    study = JSON.parse(localStorage.getItem('med-study-state') || '{}');
  } catch {
    selectedSubjects = [...subjects];
    study = {};
  }
  round = Math.max(0, Number(localStorage.getItem(`med-round-${date}`)) || 0);
  const key = storageKey(date, dailyCount, mode, selectedSubjects, round);
  const byId = new Map(mnemonics.map((item) => [item.id, item]));
  let savedIds = [];
  try { savedIds = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
  const restored = savedIds.map((id) => byId.get(id)).filter(Boolean);
  const excluded = Array.from({ length: round }, (_, index) => {
    try { return JSON.parse(localStorage.getItem(storageKey(date, dailyCount, mode, selectedSubjects, index)) || '[]'); }
    catch { return []; }
  }).flat();
  dailyItems = restored.length === dailyCount ? restored : makeDailySet(dailyCount, mode, selectedSubjects, round, excluded);
  if (restored.length !== dailyCount) localStorage.setItem(key, JSON.stringify(dailyItems.map((item) => item.id)));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSubjects() {
  el('subject-options').innerHTML = subjects.map((subject) =>
    `<label><input type="checkbox" value="${subject}" ${selectedSubjects.includes(subject) ? 'checked' : ''}> ${subject}</label>`,
  ).join('');
  el('selected-subjects').innerHTML = selectedSubjects.map((subject) =>
    `<span class="subject-chip" data-subject="${subject}">${subject}</span>`,
  ).join('');
}

function render() {
  const item = dailyItems[current];
  if (!item) return;
  const completed = dailyItems.filter((entry) => study[entry.id]?.lastDate === date).length;
  const completedToday = Object.values(study).filter((entry) => entry.lastDate === date).length;
  const reviewCount = Object.values(study).filter((entry) => entry.result === 'review').length;
  const eligibleItems = mnemonics.filter((entry) => selectedSubjects.includes(entry.subject));
  const remaining = eligibleItems.filter((entry) => !study[entry.id]).length;
  const coverageDays = Math.ceil(remaining / dailyCount);

  el('question-position').textContent = `今日第 ${round + 1} 组 · 第 ${current + 1} 题`;
  el('progress-text').textContent = `${completed} / ${dailyCount} 已完成`;
  el('progress-bar').style.width = `${(completed / dailyCount) * 100}%`;
  el('subject-badge').textContent = item.subject;
  el('subject-badge').dataset.subject = item.subject;
  el('question-kind').textContent = study[item.id] ? '复习题' : '新题';
  el('question').textContent = `${item.question}？`;
  el('answer').value = localStorage.getItem(`med-answer-${date}-${item.id}`) || '';

  const revealHtml = [];
  if (stage >= 1) revealHtml.push(`<section class="reveal mnemonic"><strong>✦ 口诀</strong>${escapeHtml(item.mnemonic)}</section>`);
  if (stage >= 2) revealHtml.push(`<section class="reveal knowledge"><strong>💡 知识点</strong>${escapeHtml(item.knowledge)}</section>`);
  if (stage >= 3) revealHtml.push(`<section class="reveal explanation"><strong>◎ 解析</strong>${escapeHtml(item.explanation)}<div class="source">来源：${item.subject}口诀 · PDF 第 ${item.page} 页</div></section>`);
  el('reveals').innerHTML = revealHtml.join('');
  el('reveal-actions').innerHTML = stage < 3
    ? `<button id="reveal-next" class="primary">${stage === 0 ? '看口诀' : stage === 1 ? '看知识点' : '看解析'}</button>`
    : '<div class="mark-actions"><button id="mark-review" class="primary outline">↻ 需要复习</button><button id="mark-mastered" class="primary">✓ 已经掌握</button></div>';

  el('dots').innerHTML = dailyItems.map((entry, index) =>
    `<button class="dot ${index === current ? 'current' : ''} ${study[entry.id]?.lastDate === date ? 'done' : ''}" data-index="${index}" aria-label="前往第 ${index + 1} 题"></button>`,
  ).join('');
  el('previous').disabled = current === 0;
  el('next').disabled = current === dailyItems.length - 1;
  el('daily-count').textContent = `${dailyCount} 道`;
  el('mode-copy').textContent = mode === 'mixed' ? '按所选科目题量智能混合。' : '所选科目轮流抽取，保持均衡。';
  el('library-count').textContent = mnemonics.length.toLocaleString();
  el('review-count').textContent = reviewCount;
  el('today-count').textContent = completedToday;
  el('coverage').textContent = `按当前 ${dailyCount} 道/天，约 ${coverageDays || 0} 天可覆盖剩余新题。`;
  el('group-complete').classList.toggle('hidden', completed !== dailyItems.length);
  el('complete-copy').textContent = `今天已完成 ${completedToday} 道，还想练就再抽一组。`;
  renderSubjects();
  wireDynamicActions();
}

function selectQuestion(index) {
  current = index;
  const item = dailyItems[current];
  stage = study[item.id]?.lastDate === date ? 3 : 0;
  render();
}

function mark(result) {
  const item = dailyItems[current];
  study[item.id] = { result, lastDate: date, seen: (study[item.id]?.seen || 0) + 1 };
  localStorage.setItem('med-study-state', JSON.stringify(study));
  if (current < dailyItems.length - 1) current += 1;
  stage = study[dailyItems[current].id]?.lastDate === date ? 3 : 0;
  render();
}

function wireDynamicActions() {
  document.querySelectorAll('.dot').forEach((dot) => dot.addEventListener('click', () => selectQuestion(Number(dot.dataset.index))));
  el('reveal-next')?.addEventListener('click', () => { stage += 1; render(); });
  el('mark-review')?.addEventListener('click', () => mark('review'));
  el('mark-mastered')?.addEventListener('click', () => mark('mastered'));
}

function initializeApp() {
  restoreState();
  el('count-input').value = dailyCount;
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  render();
  el('gate').classList.add('hidden');
  el('study-app').classList.remove('hidden');
}

el('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('unlock-button');
  const error = el('unlock-error');
  button.disabled = true;
  button.textContent = '正在解密…';
  error.textContent = '';
  try {
    mnemonics = await decryptQuestionBank(el('password').value);
    if (!Array.isArray(mnemonics) || mnemonics.length < 1) throw new Error('题库格式错误');
    initializeApp();
  } catch {
    error.textContent = '密码不正确，或题库暂时无法加载。';
  } finally {
    button.disabled = false;
    button.textContent = '进入题库';
  }
});

el('settings-toggle').addEventListener('click', () => el('settings').classList.toggle('hidden'));
el('answer').addEventListener('input', (event) => {
  localStorage.setItem(`med-answer-${date}-${dailyItems[current].id}`, event.target.value);
});
el('reset-answer').addEventListener('click', () => {
  stage = 0;
  el('answer').value = '';
  localStorage.removeItem(`med-answer-${date}-${dailyItems[current].id}`);
  render();
});
el('previous').addEventListener('click', () => current > 0 && selectQuestion(current - 1));
el('next').addEventListener('click', () => current < dailyItems.length - 1 && selectQuestion(current + 1));
el('save-settings').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('#subject-options input:checked')].map((input) => input.value);
  if (!checked.length) return;
  dailyCount = Math.min(20, Math.max(1, Math.round(Number(el('count-input').value) || 5)));
  mode = document.querySelector('input[name="mode"]:checked').value;
  selectedSubjects = subjects.filter((subject) => checked.includes(subject));
  round = 0;
  current = 0;
  stage = 0;
  dailyItems = makeDailySet(dailyCount, mode, selectedSubjects);
  localStorage.setItem('med-daily-count', String(dailyCount));
  localStorage.setItem('med-study-mode', mode);
  localStorage.setItem('med-study-subjects', JSON.stringify(selectedSubjects));
  localStorage.setItem(`med-round-${date}`, '0');
  localStorage.setItem(storageKey(date, dailyCount, mode, selectedSubjects, 0), JSON.stringify(dailyItems.map((item) => item.id)));
  el('settings').classList.add('hidden');
  render();
});
el('draw-again').addEventListener('click', () => {
  const nextRound = round + 1;
  const previousIds = Array.from({ length: nextRound }, (_, index) => {
    try { return JSON.parse(localStorage.getItem(storageKey(date, dailyCount, mode, selectedSubjects, index)) || '[]'); }
    catch { return []; }
  }).flat();
  dailyItems = makeDailySet(dailyCount, mode, selectedSubjects, nextRound, previousIds);
  round = nextRound;
  current = 0;
  stage = 0;
  localStorage.setItem(storageKey(date, dailyCount, mode, selectedSubjects, round), JSON.stringify(dailyItems.map((item) => item.id)));
  localStorage.setItem(`med-round-${date}`, String(round));
  render();
});

setInterval(() => {
  const nextDate = todayKey();
  if (mnemonics.length && nextDate !== date) {
    date = nextDate;
    current = 0;
    stage = 0;
    restoreState();
    render();
  }
}, 60_000);

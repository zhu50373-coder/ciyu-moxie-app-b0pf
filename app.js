(() => {
  "use strict";

  const STORAGE_KEY = "dictation-word-app-v1";

  const defaultState = () => ({
    words: [],
    stats: {
      totalRounds: 0,
      totalAttempts: 0,
      bestStreak: 0,
    },
  });

  let state = loadState();
  let session = null;
  let feedbackTimer = null;
  let toastTimer = null;
  let lookupDebounceTimer = null;
  let lookupGeneration = 0;
  let lookupBusy = false;
  const lookupCache = new Map();

  const elements = {
    brandSubtitle: document.querySelector("#brandSubtitle"),
    dateChip: document.querySelector("#dateChip"),
    clearSessionButton: document.querySelector("#clearSessionButton"),
    libraryView: document.querySelector("#libraryView"),
    quizView: document.querySelector("#quizView"),
    summaryView: document.querySelector("#summaryView"),
    wordInput: document.querySelector("#wordInput"),
    clearInputButton: document.querySelector("#clearInputButton"),
    addWordsButton: document.querySelector("#addWordsButton"),
    autoLookupToggle: document.querySelector("#autoLookupToggle"),
    autoFillButton: document.querySelector("#autoFillButton"),
    lookupStatus: document.querySelector("#lookupStatus"),
    libraryCount: document.querySelector("#libraryCount"),
    exportWordsButton: document.querySelector("#exportWordsButton"),
    clearWordsButton: document.querySelector("#clearWordsButton"),
    searchInput: document.querySelector("#searchInput"),
    wordList: document.querySelector("#wordList"),
    shuffleToggle: document.querySelector("#shuffleToggle"),
    quizSizeSelect: document.querySelector("#quizSizeSelect"),
    startButton: document.querySelector("#startButton"),
    quitQuizButton: document.querySelector("#quitQuizButton"),
    quizProgressText: document.querySelector("#quizProgressText"),
    progressBar: document.querySelector("#progressBar"),
    correctCount: document.querySelector("#correctCount"),
    streakCount: document.querySelector("#streakCount"),
    roundChip: document.querySelector("#roundChip"),
    stageKicker: document.querySelector("#stageKicker"),
    meaningText: document.querySelector("#meaningText"),
    answerForm: document.querySelector("#answerForm"),
    answerInput: document.querySelector("#answerInput"),
    checkButton: document.querySelector("#checkButton"),
    feedback: document.querySelector("#feedback"),
    hintButton: document.querySelector("#hintButton"),
    revealButton: document.querySelector("#revealButton"),
    summaryEmblem: document.querySelector("#summaryEmblem"),
    summarySubtitle: document.querySelector("#summarySubtitle"),
    totalStat: document.querySelector("#totalStat"),
    correctStat: document.querySelector("#correctStat"),
    reviewStat: document.querySelector("#reviewStat"),
    reviewSection: document.querySelector("#reviewSection"),
    reviewList: document.querySelector("#reviewList"),
    practiceWeakButton: document.querySelector("#practiceWeakButton"),
    restartQuizButton: document.querySelector("#restartQuizButton"),
    backToLibraryButton: document.querySelector("#backToLibraryButton"),
    toast: document.querySelector("#toast"),
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") {
        return defaultState();
      }

      return {
        ...defaultState(),
        ...saved,
        words: Array.isArray(saved.words) ? saved.words : [],
        stats: {
          ...defaultState().stats,
          ...(saved.stats || {}),
        },
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast("浏览器无法保存数据，请检查存储权限。", "error");
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      };
      return entities[character];
    });
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeTerm(value) {
    return String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"');
  }

  function normalizeAnswer(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[.!?。！？]+$/g, "");
  }

  function cleanInputLine(line) {
    return String(line)
      .trim()
      .replace(/^[-*•]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "");
  }

  function getPendingTerm(line) {
    const cleaned = cleanInputLine(line);
    if (!cleaned || /[=＝—–：:|\t]/.test(cleaned) || /\s/.test(cleaned)) {
      return null;
    }
    if (!/^[A-Za-z][A-Za-z0-9'’.-]*$/.test(cleaned)) {
      return null;
    }
    return normalizeTerm(cleaned);
  }

  function parseWordLines(text) {
    const lines = String(text ?? "")
      .split(/\r?\n/)
      .map(cleanInputLine)
      .filter(Boolean);

    const entries = [];
    const pending = [];
    const invalidLines = [];

    lines.forEach((line) => {
      const explicitMatch = line.match(/^(.*?)\s*(?:=|＝|—|–|：|:|\t)\s*(.+)$/);
      const spaceMatch = explicitMatch ? null : line.match(/^(\S+)\s+(.+)$/);
      const match = explicitMatch || spaceMatch;

      if (!match) {
        const pendingTerm = getPendingTerm(line);
        if (pendingTerm) {
          pending.push({ term: pendingTerm, raw: line });
        } else {
          invalidLines.push(line);
        }
        return;
      }

      const term = normalizeTerm(match[1]);
      const meaning = String(match[2]).trim().replace(/\s+/g, " ");

      if (!term || !meaning || term.length > 80 || meaning.length > 240) {
        invalidLines.push(line);
        return;
      }

      entries.push({ term, meaning });
    });

    return { entries, pending, invalidLines };
  }

  function getWord(id) {
    return state.words.find((word) => word.id === id);
  }

  function getMastery(word) {
    const stats = word.stats || {};
    const correct = Number(stats.correct) || 0;
    const wrong = Number(stats.wrong) || 0;

    if (correct === 0 && wrong === 0) {
      return "fresh";
    }
    if (correct > wrong) {
      return "mastered";
    }
    return "reviewing";
  }

  function getMasteryLabel(mastery) {
    if (mastery === "mastered") {
      return "已熟悉";
    }
    if (mastery === "reviewing") {
      return "需复习";
    }
    return "新词";
  }

  function getStatsText(word) {
    const correct = Number(word.stats?.correct) || 0;
    const wrong = Number(word.stats?.wrong) || 0;
    if (correct === 0 && wrong === 0) {
      return "未练习";
    }
    return `${correct} 对 · ${wrong} 错`;
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
    }
    return result;
  }

  function formatDate() {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(new Date());
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function showToast(message, type = "") {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast is-visible${type ? ` ${type}` : ""}`;
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 2600);
  }

  function showView(viewId) {
    [elements.libraryView, elements.quizView, elements.summaryView].forEach((view) => {
      const active = view.id === viewId;
      view.hidden = !active;
      view.classList.toggle("is-active", active);
    });

    if (viewId === "libraryView") {
      elements.brandSubtitle.textContent = "准备开始";
    } else if (viewId === "quizView") {
      elements.brandSubtitle.textContent = "本轮进行中";
    } else {
      elements.brandSubtitle.textContent = "默写完成";
    }
  }

  function renderLibrary() {
    const total = state.words.length;
    const masteredCount = state.words.filter((word) => getMastery(word) === "mastered").length;

    elements.libraryCount.textContent = `${total} 个`;
    elements.startButton.disabled = total === 0;
    elements.brandSubtitle.textContent =
      total > 0 ? `共 ${total} 个词 · 已熟悉 ${masteredCount} 个` : "准备开始";

    const query = normalizeTerm(elements.searchInput.value);
    const filteredWords = query
      ? state.words.filter((word) => {
          return (
            normalizeTerm(word.term).toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
            normalizeTerm(word.meaning).toLocaleLowerCase().includes(query.toLocaleLowerCase())
          );
        })
      : [...state.words];

    if (filteredWords.length === 0) {
      elements.wordList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i data-lucide="${query ? "search" : "notebook-pen"}"></i></div>
          <h3>${query ? "没有匹配结果" : "词库还是空的"}</h3>
          <p>${query ? "换一个词试试。" : "词库还没有内容。"}</p>
        </div>
      `;
    } else {
      elements.wordList.innerHTML = filteredWords
        .map((word) => {
          const mastery = getMastery(word);
          return `
            <div class="word-row" data-word-id="${escapeHtml(word.id)}">
              <div class="word-main">
                <div class="word-term-line">
                  <span class="status-dot ${mastery}" title="${getMasteryLabel(mastery)}"></span>
                  <span class="word-term">${escapeHtml(word.term)}</span>
                </div>
                <div class="word-meaning">${escapeHtml(word.meaning)}</div>
              </div>
              <span class="word-score">${escapeHtml(getStatsText(word))}</span>
              <button class="delete-word-button" type="button" data-delete-word="${escapeHtml(word.id)}" aria-label="删除 ${escapeHtml(word.term)}">
                <i data-lucide="x"></i>
              </button>
            </div>
          `;
        })
        .join("");
    }

    refreshIcons();
  }

  function renderSummary() {
    if (!session) {
      showView("libraryView");
      return;
    }

    const total = session.totalUnique;
    const correct = session.correctIds.size;
    const review = session.struggledIds.size;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    elements.totalStat.textContent = total;
    elements.correctStat.textContent = correct;
    elements.reviewStat.textContent = review;
    elements.summarySubtitle.textContent = `正确率 ${accuracy}% · 本轮最高连续答对 ${session.bestStreak} 个`;

    const reviewWords = [...session.struggledIds]
      .map((id) => getWord(id))
      .filter(Boolean)
      .sort((first, second) => first.term.localeCompare(second.term, "zh-CN"));

    elements.reviewSection.hidden = reviewWords.length === 0;
    elements.practiceWeakButton.disabled = reviewWords.length === 0;
    elements.reviewList.innerHTML = reviewWords
      .map(
        (word) => `
          <div class="review-item">
            <strong>${escapeHtml(word.term)}</strong>
            <span>${escapeHtml(word.meaning)}</span>
          </div>
        `,
      )
      .join("");

    if (accuracy >= 90) {
      elements.summaryEmblem.style.background = "linear-gradient(145deg, #e0a431, #b87a1f)";
    } else if (accuracy >= 60) {
      elements.summaryEmblem.style.background = "linear-gradient(145deg, #2a9a7e, #087a67)";
    } else {
      elements.summaryEmblem.style.background = "linear-gradient(145deg, #d47a62, #b45b2f)";
    }

    refreshIcons();
  }

  function updateQuizHeader() {
    const completed = session.doneIds.size;
    const total = session.totalUnique;
    const percentage = total > 0 ? (completed / total) * 100 : 0;

    elements.quizProgressText.textContent = `${completed} / ${total}`;
    elements.progressBar.style.width = `${percentage}%`;
    elements.correctCount.textContent = session.correctIds.size;
    elements.streakCount.textContent = session.streak;
  }

  function setStageLocked(locked) {
    session.locked = locked;
    elements.answerInput.disabled = locked;
    elements.checkButton.disabled = locked;
    elements.hintButton.disabled = locked;
    elements.revealButton.disabled = locked;
  }

  function showCurrentQuestion() {
    if (!session || session.queue.length === 0) {
      finishQuiz();
      return;
    }

    const word = getWord(session.queue[0]);
    if (!word) {
      session.queue.shift();
      showCurrentQuestion();
      return;
    }

    session.currentHinted = false;
    setStageLocked(false);
    clearTimeout(feedbackTimer);

    const nextNumber = Math.min(session.doneIds.size + 1, session.totalUnique);
    elements.roundChip.textContent = `第 ${nextNumber} 题`;
    elements.stageKicker.textContent = session.shuffled ? "随机默写" : "顺序默写";
    elements.meaningText.textContent = word.meaning;
    elements.answerInput.value = "";
    elements.answerInput.classList.remove("has-error");
    elements.feedback.className = "feedback";
    elements.feedback.innerHTML = "";
    elements.hintButton.disabled = false;
    elements.revealButton.disabled = false;
    elements.checkButton.disabled = false;

    updateQuizHeader();
    window.setTimeout(() => elements.answerInput.focus(), 80);
  }

  function showFeedback(type, word, userAnswer = "") {
    setStageLocked(true);
    elements.feedback.className = `feedback ${type}`;

    if (type === "success") {
      elements.feedback.innerHTML = `
        <i data-lucide="check-circle-2"></i>
        <span><strong>正确</strong> · ${escapeHtml(word.term)}</span>
      `;
    } else if (type === "error") {
      elements.feedback.innerHTML = `
        <i data-lucide="x-circle"></i>
        <span><strong>正确答案</strong>：${escapeHtml(word.term)}${
          userAnswer ? ` · 你写的是：${escapeHtml(userAnswer)}` : ""
        }</span>
      `;
      elements.answerInput.classList.add("has-error");
    } else if (type === "reveal") {
      elements.feedback.innerHTML = `
        <i data-lucide="eye"></i>
        <span><strong>答案</strong>：${escapeHtml(word.term)}</span>
      `;
    } else if (type === "hint") {
      elements.feedback.innerHTML = `
        <i data-lucide="lightbulb"></i>
        <span><strong>首字母</strong>：${escapeHtml(getFirstLetter(word.term))}</span>
      `;
      setStageLocked(false);
      elements.hintButton.disabled = true;
      window.setTimeout(() => elements.answerInput.focus(), 40);
      return;
    }

    refreshIcons();
  }

  function getFirstLetter(term) {
    const first = [...String(term)].find((character) => /\p{L}|\p{N}/u.test(character));
    return first || String(term).slice(0, 1) || "?";
  }

  function updateWordStats(word, result) {
    if (!word.stats) {
      word.stats = {
        correct: 0,
        wrong: 0,
        lastResult: null,
        lastPracticedAt: null,
      };
    }

    word.stats[result === "correct" ? "correct" : "wrong"] += 1;
    word.stats.lastResult = result;
    word.stats.lastPracticedAt = Date.now();
  }

  function advanceQuiz(delay = 760) {
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      if (session && session.queue.length > 0) {
        showCurrentQuestion();
      } else {
        finishQuiz();
      }
    }, delay);
  }

  function handleAnswer() {
    if (!session || session.locked || session.queue.length === 0) {
      return;
    }

    const wordId = session.queue[0];
    const word = getWord(wordId);
    const rawAnswer = elements.answerInput.value;
    if (!word || !normalizeAnswer(rawAnswer)) {
      showToast("还没有填写单词。", "error");
      return;
    }

    session.attempts += 1;
    const isCorrect = normalizeAnswer(rawAnswer) === normalizeAnswer(word.term);

    if (isCorrect) {
      session.queue.shift();
      session.doneIds.add(wordId);
      session.correctIds.add(wordId);
      session.streak += 1;
      session.bestStreak = Math.max(session.bestStreak, session.streak);
      updateWordStats(word, "correct");
      showFeedback("success", word);
    } else {
      session.queue.shift();
      session.struggledIds.add(wordId);
      session.streak = 0;
      updateWordStats(word, "wrong");

      const insertAt = Math.min(
        session.queue.length,
        2 + Math.floor(Math.random() * Math.min(4, session.queue.length + 1)),
      );
      session.queue.splice(insertAt, 0, wordId);
      showFeedback("error", word, rawAnswer.trim());
    }

    updateQuizHeader();
    saveState();
    advanceQuiz(isCorrect ? 620 : 1280);
  }

  function handleReveal() {
    if (!session || session.locked || session.queue.length === 0) {
      return;
    }

    const wordId = session.queue[0];
    const word = getWord(wordId);
    if (!word) {
      return;
    }

    session.attempts += 1;
    session.queue.shift();
    session.doneIds.add(wordId);
    session.struggledIds.add(wordId);
    session.streak = 0;
    updateWordStats(word, "wrong");
    showFeedback("reveal", word);
    updateQuizHeader();
    saveState();
    advanceQuiz(1080);
  }

  function handleHint() {
    if (!session || session.locked || session.currentHinted || session.queue.length === 0) {
      return;
    }

    const word = getWord(session.queue[0]);
    if (!word) {
      return;
    }

    session.currentHinted = true;
    session.hintsUsed += 1;
    showFeedback("hint", word);
  }

  function startQuiz(sourceIds, shouldShuffle) {
    const availableIds = sourceIds.filter((id) => getWord(id));
    if (availableIds.length === 0) {
      showToast("词库里还没有可练习的单词。", "error");
      return;
    }

    const shuffleEnabled = shouldShuffle ?? elements.shuffleToggle.checked;
    const queue = shuffleEnabled ? shuffle(availableIds) : [...availableIds];

    session = {
      queue,
      shuffled: shuffleEnabled,
      totalUnique: availableIds.length,
      doneIds: new Set(),
      correctIds: new Set(),
      struggledIds: new Set(),
      attempts: 0,
      streak: 0,
      bestStreak: 0,
      hintsUsed: 0,
      currentHinted: false,
      locked: false,
    };

    showView("quizView");
    showCurrentQuestion();
  }

  function finishQuiz() {
    if (!session) {
      showView("libraryView");
      return;
    }

    clearTimeout(feedbackTimer);
    state.stats.totalRounds += 1;
    state.stats.totalAttempts += session.attempts;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, session.bestStreak);
    saveState();

    renderSummary();
    showView("summaryView");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function getQuizSourceIds() {
    const requestedSize = Number(elements.quizSizeSelect.value) || 0;
    const ids = state.words.map((word) => word.id);
    return requestedSize > 0 ? shuffle(ids).slice(0, requestedSize) : ids;
  }

  function setLookupStatus(message = "", type = "") {
    elements.lookupStatus.className = `lookup-status${type ? ` ${type}` : ""}`;
    if (!message) {
      elements.lookupStatus.innerHTML = "";
      return;
    }

    const icon =
      type === "loading"
        ? '<i class="spin" data-lucide="loader-circle"></i>'
        : type === "success"
          ? '<i data-lucide="check-circle-2"></i>'
          : type === "error"
            ? '<i data-lucide="alert-circle"></i>'
            : "";
    elements.lookupStatus.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
    refreshIcons();
  }

  function setLookupBusy(busy) {
    lookupBusy = busy;
    elements.autoFillButton.disabled = busy;
    elements.addWordsButton.disabled = busy;
    elements.addWordsButton.innerHTML = busy
      ? '<i class="spin" data-lucide="loader-circle"></i><span>正在生成释义</span>'
      : '<i data-lucide="plus"></i><span>加入词库</span>';
    refreshIcons();
  }

  function cleanAutoMeaning(value) {
    let text = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (
      !text ||
      /MYMEMORY WARNING|QUERY LENGTH LIMIT|NO QUERY SPECIFIED|INVALID SOURCE LANGUAGE/i.test(text)
    ) {
      return "";
    }

    text = text
      .replace(/\s*,\s*/g, "，")
      .replace(/\s*;\s*/g, "；")
      .replace(/，{2,}/g, "，")
      .replace(/；{2,}/g, "；")
      .replace(/[.。]\s*$/g, "")
      .trim();

    if (!/[\u3400-\u9fff]/.test(text)) {
      return "";
    }

    return Array.from(text).slice(0, 240).join("");
  }

  async function lookupMeaning(term) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 9000);

    try {
      const url = new URL("https://api.mymemory.translated.net/get");
      url.searchParams.set("q", term);
      url.searchParams.set("langpair", "en|zh-CN");
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        return "";
      }

      const payload = await response.json();
      return cleanAutoMeaning(payload?.responseData?.translatedText);
    } catch {
      return "";
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function lookupMeaningCached(term) {
    const key = normalizeTerm(term).toLocaleLowerCase();
    if (!lookupCache.has(key)) {
      const request = lookupMeaning(term).then((meaning) => {
        if (!meaning) {
          lookupCache.delete(key);
        }
        return meaning;
      });
      lookupCache.set(key, request);
    }
    return lookupCache.get(key);
  }

  async function runLookupTasks(tasks, onResult) {
    let cursor = 0;
    const workerCount = Math.min(4, tasks.length);

    async function worker() {
      while (cursor < tasks.length) {
        const task = tasks[cursor];
        cursor += 1;
        const meaning = await lookupMeaningCached(task.term);
        onResult(task, meaning);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function completeMissingMeanings() {
    const lines = elements.wordInput.value.split(/\r?\n/);
    const tasks = [];

    lines.forEach((raw, index) => {
      const term = getPendingTerm(raw);
      if (term) {
        tasks.push({ raw, index, term });
      }
    });

    if (tasks.length === 0) {
      return { total: 0, failed: 0 };
    }

    let completed = 0;
    let processed = 0;
    setLookupBusy(true);
    setLookupStatus(`正在查找 ${tasks.length} 个单词…`, "loading");

    await runLookupTasks(tasks, (task, meaning) => {
      const currentLines = elements.wordInput.value.split(/\r?\n/);
      if (currentLines[task.index] !== task.raw) {
        processed += 1;
        setLookupStatus(
          `已完成 ${processed} / ${tasks.length}`,
          processed === tasks.length ? "success" : "loading",
        );
        return;
      }

      if (meaning) {
        currentLines[task.index] = `${task.term}\t${meaning}`;
        elements.wordInput.value = currentLines.join("\n");
        completed += 1;
      }

      processed += 1;
      setLookupStatus(
        `已完成 ${processed} / ${tasks.length}`,
        processed === tasks.length ? "success" : "loading",
      );
    });

    const failed = tasks.length - completed;
    setLookupStatus(
      failed > 0 ? `已补全 ${completed} 个，${failed} 个未查到` : `已补全 ${completed} 个释义`,
      failed > 0 ? "error" : "success",
    );
    setLookupBusy(false);
    return { total: tasks.length, failed };
  }

  function scheduleLiveLookup() {
    window.clearTimeout(lookupDebounceTimer);
    lookupGeneration += 1;
    const generation = lookupGeneration;

    if (!elements.autoLookupToggle.checked || lookupBusy) {
      setLookupStatus();
      return;
    }

    const currentLines = elements.wordInput.value.split(/\r?\n/);
    const lastRawLine = [...currentLines].reverse().find((line) => cleanInputLine(line));
    const term = getPendingTerm(lastRawLine);

    if (!term) {
      setLookupStatus();
      return;
    }

    setLookupStatus(`正在查找 “${term}”…`, "loading");
    lookupDebounceTimer = window.setTimeout(async () => {
      const meaning = await lookupMeaningCached(term);
      if (generation !== lookupGeneration || !elements.autoLookupToggle.checked) {
        return;
      }

      const liveLines = elements.wordInput.value.split(/\r?\n/);
      const reverseIndex = [...liveLines].reverse().findIndex((line) => line === lastRawLine);
      if (reverseIndex < 0) {
        return;
      }

      const lineIndex = liveLines.length - 1 - reverseIndex;
      if (!meaning) {
        setLookupStatus(`未查到 “${term}” 的释义`, "error");
        return;
      }

      if (liveLines[lineIndex] === lastRawLine) {
        liveLines[lineIndex] = `${term}\t${meaning}`;
        elements.wordInput.value = liveLines.join("\n");
      }
      setLookupStatus(`${term} → ${meaning}`, "success");
    }, 800);
  }

  async function autoFillMissingMeanings() {
    if (lookupBusy) {
      return;
    }

    const { pending } = parseWordLines(elements.wordInput.value);
    if (pending.length === 0) {
      showToast("没有需要补全的单词。");
      return;
    }

    await completeMissingMeanings();
  }

  async function addWords() {
    if (lookupBusy) {
      return;
    }

    const initial = parseWordLines(elements.wordInput.value);
    if (initial.entries.length === 0 && initial.pending.length === 0) {
      showToast(
        initial.invalidLines.length > 0
          ? `无法识别 ${initial.invalidLines.length} 行，请检查输入内容。`
          : "还没有输入单词。",
        "error",
      );
      return;
    }

    if (initial.pending.length > 0 && elements.autoLookupToggle.checked) {
      await completeMissingMeanings();
    }

    const parsed = parseWordLines(elements.wordInput.value);
    const entries = parsed.entries;
    const invalidLines = [...parsed.invalidLines, ...parsed.pending.map((item) => item.raw)];

    if (entries.length === 0) {
      showToast(`没有查到可用释义，剩余 ${invalidLines.length} 行未加入。`, "error");
      elements.wordInput.value = invalidLines.join("\n");
      return;
    }

    let added = 0;
    let updated = 0;

    entries.forEach(({ term, meaning }) => {
      const existing = state.words.find((word) => normalizeTerm(word.term) === term);
      if (existing) {
        existing.meaning = meaning;
        updated += 1;
      } else {
        state.words.push({
          id: makeId(),
          term,
          meaning,
          stats: {
            correct: 0,
            wrong: 0,
            lastResult: null,
            lastPracticedAt: null,
          },
          createdAt: Date.now(),
        });
        added += 1;
      }
    });

    saveState();
    renderLibrary();
    elements.wordInput.value = invalidLines.join("\n");

    const parts = [];
    if (added > 0) parts.push(`新增 ${added} 个`);
    if (updated > 0) parts.push(`更新 ${updated} 个`);
    if (invalidLines.length > 0) parts.push(`跳过 ${invalidLines.length} 行`);
    showToast(parts.length > 0 ? parts.join(" · ") : "词库已更新。");

    if (invalidLines.length === 0) {
      elements.wordInput.focus();
    }
  }

  function clearWords() {
    if (state.words.length === 0) {
      showToast("词库已经是空的。");
      return;
    }

    if (!window.confirm(`确定清空词库中的 ${state.words.length} 个单词吗？`)) {
      return;
    }

    state.words = [];
    saveState();
    renderLibrary();
    showToast("词库已清空。");
  }

  function resetLearningStats() {
    if (!window.confirm("确定清空所有单词的学习记录吗？单词本身会保留。")) {
      return;
    }

    state.words.forEach((word) => {
      word.stats = {
        correct: 0,
        wrong: 0,
        lastResult: null,
        lastPracticedAt: null,
      };
    });
    state.stats = defaultState().stats;
    saveState();
    renderLibrary();
    showToast("学习记录已重置。");
  }

  function exportWords() {
    if (state.words.length === 0) {
      showToast("词库为空，暂无可导出的内容。", "error");
      return;
    }

    const content = state.words.map((word) => `${word.term}\t${word.meaning}`).join("\n");
    const blob = new Blob([`\ufeff${content}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `我的单词词库-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${state.words.length} 个单词。`);
  }

  function quitQuiz() {
    if (!session || window.confirm("确定退出本轮吗？当前进度不会保存。")) {
      clearTimeout(feedbackTimer);
      session = null;
      showView("libraryView");
      renderLibrary();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function bindEvents() {
    elements.addWordsButton.addEventListener("click", () => addWords());
    elements.autoFillButton.addEventListener("click", () => autoFillMissingMeanings());
    elements.autoLookupToggle.addEventListener("change", () => {
      lookupGeneration += 1;
      window.clearTimeout(lookupDebounceTimer);
      setLookupStatus();
    });
    elements.wordInput.addEventListener("input", scheduleLiveLookup);
    elements.wordInput.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        addWords();
      }
    });
    elements.clearInputButton.addEventListener("click", () => {
      lookupGeneration += 1;
      window.clearTimeout(lookupDebounceTimer);
      elements.wordInput.value = "";
      setLookupStatus();
      elements.wordInput.focus();
    });
    elements.clearWordsButton.addEventListener("click", clearWords);
    elements.clearSessionButton.addEventListener("click", resetLearningStats);
    elements.exportWordsButton.addEventListener("click", exportWords);
    elements.searchInput.addEventListener("input", renderLibrary);
    elements.startButton.addEventListener("click", () => startQuiz(getQuizSourceIds()));

    elements.wordList.addEventListener("click", (event) => {
      const deleteButton = event.target.closest("[data-delete-word]");
      if (!deleteButton) {
        return;
      }
      const wordId = deleteButton.dataset.deleteWord;
      state.words = state.words.filter((word) => word.id !== wordId);
      saveState();
      renderLibrary();
      showToast("已删除这个单词。");
    });

    elements.answerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleAnswer();
    });
    elements.hintButton.addEventListener("click", handleHint);
    elements.revealButton.addEventListener("click", handleReveal);
    elements.quitQuizButton.addEventListener("click", quitQuiz);

    elements.practiceWeakButton.addEventListener("click", () => {
      if (session) {
        startQuiz([...session.struggledIds], true);
      }
    });
    elements.restartQuizButton.addEventListener("click", () => startQuiz(getQuizSourceIds()));
    elements.backToLibraryButton.addEventListener("click", () => {
      session = null;
      showView("libraryView");
      renderLibrary();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    window.addEventListener("keydown", (event) => {
      if (elements.quizView.hidden || event.key !== "Escape" || event.target !== elements.answerInput) {
        return;
      }
      elements.answerInput.value = "";
      elements.answerInput.focus();
    });
  }

  function initialize() {
    elements.dateChip.textContent = formatDate();
    bindEvents();
    renderLibrary();
    refreshIcons();
  }

  initialize();
})();

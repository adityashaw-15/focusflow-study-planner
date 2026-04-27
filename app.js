const CACHE_KEY = "study-planner-smart-timetable:cache:v2";
const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8090" : "";
const API = {
  health: `${API_BASE}/api/health`,
  state: `${API_BASE}/api/state`,
  reset: `${API_BASE}/api/reset-demo`
};

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const START_MINUTES = 6 * 60;
const END_MINUTES = 22 * 60;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (END_MINUTES - START_MINUTES) / SLOT_MINUTES;
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const MODE_LABEL = {
  deep: "Deep focus",
  review: "Revision",
  class: "Class",
  lab: "Lab",
  auto: "Auto focus"
};

const defaultState = createDefaultState();

const refs = {
  todayLabel: document.querySelector("#todayLabel"),
  plannedHoursStat: document.querySelector("#plannedHoursStat"),
  dueSoonStat: document.querySelector("#dueSoonStat"),
  completionStat: document.querySelector("#completionStat"),
  focusModeStat: document.querySelector("#focusModeStat"),
  todayAgenda: document.querySelector("#todayAgenda"),
  timetableGrid: document.querySelector("#timetableGrid"),
  upcomingSessions: document.querySelector("#upcomingSessions"),
  focusQueue: document.querySelector("#focusQueue"),
  taskList: document.querySelector("#taskList"),
  balanceList: document.querySelector("#balanceList"),
  deadlineList: document.querySelector("#deadlineList"),
  plannerStatus: document.querySelector("#plannerStatus"),
  syncPill: document.querySelector("#syncPill"),
  sessionForm: document.querySelector("#sessionForm"),
  taskForm: document.querySelector("#taskForm"),
  timerForm: document.querySelector("#timerForm"),
  sessionDay: document.querySelector("#sessionDay"),
  sessionStart: document.querySelector("#sessionStart"),
  sessionEnd: document.querySelector("#sessionEnd"),
  taskDueDate: document.querySelector("#taskDueDate"),
  autoPlanButton: document.querySelector("#autoPlanButton"),
  clearAutoButton: document.querySelector("#clearAutoButton"),
  resetDemoButton: document.querySelector("#resetDemoButton"),
  refreshInsightsButton: document.querySelector("#refreshInsightsButton"),
  filterButtons: Array.from(document.querySelectorAll(".filter-button")),
  timerPresets: document.querySelector("#timerPresets"),
  presetButtons: Array.from(document.querySelectorAll("[data-duration-seconds]")),
  timerStatePill: document.querySelector("#timerStatePill"),
  timerClock: document.querySelector("#timerClock"),
  timerLabelDisplay: document.querySelector("#timerLabelDisplay"),
  timerMeta: document.querySelector("#timerMeta"),
  timerLabelInput: document.querySelector("#timerLabelInput"),
  timerHours: document.querySelector("#timerHours"),
  timerMinutes: document.querySelector("#timerMinutes"),
  timerStartButton: document.querySelector("#timerStartButton"),
  timerPauseButton: document.querySelector("#timerPauseButton"),
  timerResumeButton: document.querySelector("#timerResumeButton"),
  timerResetButton: document.querySelector("#timerResetButton")
};

let state = cloneState(defaultState);
let taskFilter = "pending";
let backendReachable = false;
let backendStatus = "connecting";
let timerTickHandle = null;
let timerCompletionInFlight = false;

initializeApp();

async function initializeApp() {
  populateDayOptions();
  applyDefaultFormValues();
  bindEvents();
  startTimerTicker();
  state = normalizeState(loadCachedState() || defaultState);
  syncTimerInputsFromState();
  renderApp();
  await fetchAndApplyState({ announceSuccess: true });
}

function bindEvents() {
  refs.sessionForm.addEventListener("submit", handleSessionSubmit);
  refs.taskForm.addEventListener("submit", handleTaskSubmit);
  refs.timerForm.addEventListener("submit", handleTimerSubmit);

  refs.autoPlanButton.addEventListener("click", async () => {
    const result = autoPlanTasks();
    if (!result) {
      setStatus("No open slot found yet for the highest-priority tasks.");
      return;
    }
    renderApp();
    await persistState(
      "Planned urgent tasks into open study windows.",
      "Tasks were planned in this browser cache. Start the Java server to save them into SQL."
    );
  });

  refs.clearAutoButton.addEventListener("click", async () => {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((session) => session.mode !== "auto");
    const removed = before - state.sessions.length;
    renderApp();
    if (!removed) {
      setStatus("No auto-planned blocks to clear.");
      return;
    }
    await persistState(
      `Removed ${removed} auto-planned block${removed > 1 ? "s" : ""}.`,
      "Auto-planned blocks were cleared in this browser cache. Start the Java server to persist the change."
    );
  });

  refs.resetDemoButton.addEventListener("click", restoreDemoData);

  refs.refreshInsightsButton.addEventListener("click", async () => {
    renderApp();
    const refreshed = await fetchAndApplyState({ announceSuccess: false });
    if (refreshed) {
      setStatus("Insights refreshed from the Java + SQL backend.");
    } else {
      setStatus("Backend not reachable. Showing the latest cached planner state.");
    }
  });

  refs.timerPresets.addEventListener("click", handleTimerPresetClick);
  refs.timerStartButton.addEventListener("click", startFocusTimer);
  refs.timerPauseButton.addEventListener("click", pauseFocusTimer);
  refs.timerResumeButton.addEventListener("click", resumeFocusTimer);
  refs.timerResetButton.addEventListener("click", resetFocusTimer);

  refs.filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      taskFilter = button.dataset.filter;
      refs.filterButtons.forEach((item) => item.classList.toggle("active", item === button));
      renderTasks();
    });
  });

  refs.taskList.addEventListener("click", handleTaskActions);
  refs.upcomingSessions.addEventListener("click", handleSessionActions);
  refs.focusQueue.addEventListener("click", handleFocusActions);
}

async function handleSessionSubmit(event) {
  event.preventDefault();

  try {
    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("sessionTitle") || "").trim();
    const subject = String(formData.get("sessionSubject") || "").trim();
    const day = String(formData.get("sessionDay") || "");
    const start = String(formData.get("sessionStart") || "");
    const end = String(formData.get("sessionEnd") || "");

    if (!title || !subject) {
      setStatus("Give the study block both a title and a subject.");
      return;
    }

    if (toMinutes(end) <= toMinutes(start)) {
      setStatus("End time needs to be later than the start time.");
      return;
    }

    const session = {
      id: createId("session"),
      title,
      subject,
      day,
      start,
      end,
      mode: String(formData.get("sessionMode") || "deep")
    };

    state.sessions.push(session);
    sortSessions();
    renderApp();

    event.currentTarget.reset();
    refs.sessionDay.value = getTodayDayName();
    refs.sessionStart.value = "17:00";
    refs.sessionEnd.value = "18:30";

    await persistState(
      `Added ${session.title} to ${session.day}.`,
      `Added ${session.title} to ${session.day} in the browser cache. Start the Java server to save it into SQL.`
    );
  } catch (error) {
    console.error(error);
    setStatus("That study block could not be saved. Check the time fields and try again.");
  }
}

async function handleTaskSubmit(event) {
  event.preventDefault();

  try {
    const formData = new FormData(event.currentTarget);
    const task = {
      id: createId("task"),
      title: String(formData.get("taskTitle") || "").trim(),
      subject: String(formData.get("taskSubject") || "").trim(),
      dueDate: String(formData.get("taskDueDate") || ""),
      minutes: Number(formData.get("taskMinutes") || 0),
      priority: String(formData.get("taskPriority") || "medium"),
      done: false
    };

    if (!task.title || !task.subject || !isValidDateString(task.dueDate)) {
      setStatus("The task needs a title, a subject, and a valid due date.");
      return;
    }

    state.tasks.unshift(task);
    renderApp();

    event.currentTarget.reset();
    refs.taskDueDate.value = offsetDateString(1);
    document.querySelector("#taskPriority").value = "medium";
    document.querySelector("#taskMinutes").value = "60";

    await persistState(
      `Added task: ${task.title}.`,
      `Added task: ${task.title} in the browser cache. Start the Java server to save it into SQL.`
    );
  } catch (error) {
    console.error(error);
    setStatus("That task could not be saved. Check the form fields and try again.");
  }
}

async function handleTaskActions(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const taskId = button.dataset.id;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }

  const action = button.dataset.action;

  if (action === "toggle") {
    task.done = !task.done;
    renderApp();
    await persistState(
      task.done ? `Completed ${task.title}.` : `Marked ${task.title} as pending.`,
      task.done
        ? `Marked ${task.title} as done in this browser cache. Start the Java server to sync the change.`
        : `Marked ${task.title} as pending in this browser cache. Start the Java server to sync the change.`
    );
    return;
  }

  if (action === "delete") {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    state.sessions = state.sessions.filter((session) => session.linkedTaskId !== taskId);
    renderApp();
    await persistState(
      `Removed task: ${task.title}.`,
      `Removed task: ${task.title} in this browser cache. Start the Java server to sync the change.`
    );
    return;
  }

  if (action === "plan") {
    const result = autoPlanTasks(taskId);
    if (!result) {
      setStatus(`No open slot found yet for ${task.title}.`);
      return;
    }
    renderApp();
    await persistState(
      `Planned ${task.title}.`,
      `Planned ${task.title} in this browser cache. Start the Java server to save it into SQL.`
    );
  }
}

async function handleSessionActions(event) {
  const button = event.target.closest("button[data-remove-session]");
  if (!button) {
    return;
  }

  const sessionId = button.dataset.removeSession;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  state.sessions = state.sessions.filter((item) => item.id !== sessionId);
  renderApp();

  await persistState(
    `Removed ${session.title} from the timetable.`,
    `Removed ${session.title} from the timetable in this browser cache. Start the Java server to sync it.`
  );
}

async function handleFocusActions(event) {
  const button = event.target.closest("button[data-plan-task]");
  if (!button) {
    return;
  }

  const taskId = button.dataset.planTask;
  const task = state.tasks.find((item) => item.id === taskId);
  const result = autoPlanTasks(taskId);
  if (!result) {
    if (task) {
      setStatus(`Could not fit ${task.title} into a free slot yet.`);
    }
    return;
  }
  renderApp();

  if (task) {
    await persistState(
      `Planned ${task.title}.`,
      `Planned ${task.title} in this browser cache. Start the Java server to save it into SQL.`
    );
  }
}

async function handleTimerSubmit(event) {
  event.preventDefault();

  try {
    if (state.focusTimer.running) {
      setStatus("Pause or reset the current timer before changing its duration.");
      return;
    }

    const hours = clampNumber(Number(refs.timerHours.value || 0), 0, 12);
    const minutes = clampNumber(Number(refs.timerMinutes.value || 0), 0, 59);
    const totalSeconds = (hours * 60 + minutes) * 60;

    if (totalSeconds < 60) {
      setStatus("Pick at least 1 minute for the focus timer.");
      return;
    }

    state.focusTimer = buildTimerState({
      label: String(refs.timerLabelInput.value || "").trim() || "Deep focus block",
      durationSeconds: totalSeconds,
      remainingSeconds: totalSeconds,
      running: false,
      startedAt: null,
      endsAt: null,
      lastCompletedAt: null
    });

    syncTimerInputsFromState();
    renderTimer();
    await persistState(
      `Focus timer set for ${formatDurationWords(totalSeconds)}.`,
      `Focus timer set for ${formatDurationWords(totalSeconds)} in this browser cache. Start the Java server to save it into SQL.`
    );
  } catch (error) {
    console.error(error);
    setStatus("The focus timer could not be updated. Check the custom time values and try again.");
  }
}

async function handleTimerPresetClick(event) {
  const button = event.target.closest("button[data-duration-seconds]");
  if (!button) {
    return;
  }

  if (state.focusTimer.running) {
    setStatus("Pause or reset the current timer before switching to a new preset.");
    return;
  }

  const seconds = Number(button.dataset.durationSeconds || 0);
  if (!seconds) {
    return;
  }

  state.focusTimer = buildTimerState({
    label: String(refs.timerLabelInput.value || "").trim() || "Deep focus block",
    durationSeconds: seconds,
    remainingSeconds: seconds,
    running: false,
    startedAt: null,
    endsAt: null,
    lastCompletedAt: null
  });

  syncTimerInputsFromState();
  renderTimer();
  await persistState(
    `Focus timer set for ${formatDurationWords(seconds)}.`,
    `Focus timer set for ${formatDurationWords(seconds)} in this browser cache. Start the Java server to save it into SQL.`
  );
}

async function startFocusTimer() {
  const timer = buildTimerState(state.focusTimer);
  if (timer.running) {
    return;
  }

  const seconds = timer.remainingSeconds > 0 ? timer.remainingSeconds : timer.durationSeconds;
  const now = new Date();

  state.focusTimer = buildTimerState({
    ...timer,
    label: String(refs.timerLabelInput.value || timer.label || "Deep focus block").trim() || "Deep focus block",
    durationSeconds: timer.durationSeconds,
    remainingSeconds: seconds,
    running: true,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    lastCompletedAt: null
  });

  renderTimer();
  await persistState(
    `Focus timer started for ${formatDurationWords(seconds)}.`,
    `Focus timer started in this browser cache. Start the Java server to keep it persistent in SQL.`
  );
}

async function pauseFocusTimer() {
  const timer = buildTimerState(state.focusTimer);
  if (!timer.running) {
    return;
  }

  state.focusTimer = buildTimerState({
    ...timer,
    running: false,
    startedAt: null,
    endsAt: null
  });

  renderTimer();
  await persistState(
    "Focus timer paused.",
    "Focus timer paused in this browser cache. Start the Java server to save the paused state."
  );
}

async function resumeFocusTimer() {
  const timer = buildTimerState(state.focusTimer);
  if (timer.running || timer.remainingSeconds <= 0) {
    return;
  }

  const now = new Date();
  state.focusTimer = buildTimerState({
    ...timer,
    running: true,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + timer.remainingSeconds * 1000).toISOString(),
    lastCompletedAt: null
  });

  renderTimer();
  await persistState(
    "Focus timer resumed.",
    "Focus timer resumed in this browser cache. Start the Java server to keep the timer persistent in SQL."
  );
}

async function resetFocusTimer() {
  const timer = buildTimerState(state.focusTimer);
  state.focusTimer = buildTimerState({
    ...timer,
    remainingSeconds: timer.durationSeconds,
    running: false,
    startedAt: null,
    endsAt: null,
    lastCompletedAt: null
  });

  syncTimerInputsFromState();
  renderTimer();
  await persistState(
    "Focus timer reset.",
    "Focus timer reset in this browser cache. Start the Java server to save the reset state into SQL."
  );
}

function startTimerTicker() {
  if (timerTickHandle) {
    window.clearInterval(timerTickHandle);
  }

  timerTickHandle = window.setInterval(async () => {
    const previousTimer = state.focusTimer;
    const normalizedTimer = buildTimerState(previousTimer);
    const justCompleted =
      previousTimer.running &&
      !normalizedTimer.running &&
      normalizedTimer.remainingSeconds === 0 &&
      normalizedTimer.lastCompletedAt &&
      normalizedTimer.lastCompletedAt !== previousTimer.lastCompletedAt;

    state.focusTimer = normalizedTimer;
    renderTimer();

    if (justCompleted && !timerCompletionInFlight) {
      timerCompletionInFlight = true;
      try {
        await persistState(
          "Focus block complete. Take a quick breath before the next one.",
          "Focus block finished in this browser cache. Start the Java server to save the timer history into SQL."
        );
      } finally {
        timerCompletionInFlight = false;
      }
    }
  }, 1000);
}

async function restoreDemoData() {
  try {
    const remoteState = await requestJson(API.reset, { method: "POST" });
    state = normalizeState(remoteState);
    backendReachable = true;
    backendStatus = "online";
    saveCachedState(state);
    syncTimerInputsFromState();
    renderApp();
    setStatus("Demo planner restored from the Java + SQL backend.");
  } catch (error) {
    console.error(error);
    backendReachable = false;
    backendStatus = "offline";
    state = normalizeState(createDefaultState());
    saveCachedState(state);
    syncTimerInputsFromState();
    renderApp();
    setStatus("Demo planner restored in this browser cache. Start the Java server to save it into SQL.");
  }
}

async function fetchAndApplyState({ announceSuccess }) {
  try {
    const remoteState = await requestJson(API.state);
    state = normalizeState(remoteState);
    backendReachable = true;
    backendStatus = "online";
    saveCachedState(state);
    syncTimerInputsFromState();
    renderApp();
    if (announceSuccess) {
      setStatus("Connected to Java + SQL. Planner data will survive server restarts.");
    }
    return true;
  } catch (error) {
    console.error(error);
    backendReachable = false;
    backendStatus = "offline";
    renderApp();
    if (announceSuccess) {
      setStatus("Backend is offline. Start the Java server on http://127.0.0.1:8090 to sync this planner with SQL.");
    }
    return false;
  }
}

async function persistState(successMessage, offlineMessage) {
  saveCachedState(state);

  try {
    const savedState = await requestJson(API.state, {
      method: "PUT",
      body: JSON.stringify(serializeState(state))
    });
    state = normalizeState(savedState);
    backendReachable = true;
    backendStatus = "online";
    saveCachedState(state);
    renderApp();
    if (successMessage) {
      setStatus(successMessage);
    }
    return true;
  } catch (error) {
    console.error(error);
    backendReachable = false;
    backendStatus = "offline";
    renderApp();
    if (offlineMessage) {
      setStatus(offlineMessage);
    }
    return false;
  }
}

function renderApp() {
  sortSessions();
  const insights = buildInsights();
  updateSyncPill();
  renderSummary(insights);
  renderTodayAgenda(insights);
  renderTimetable();
  renderUpcomingSessions();
  renderFocusQueue(insights);
  renderTasks();
  renderBalance(insights);
  renderDeadlines(insights);
  renderTimer();
}

function renderSummary(insights) {
  refs.todayLabel.textContent = formatLongDate(new Date());
  refs.plannedHoursStat.textContent = `${(insights.totalSessionMinutes / 60).toFixed(1)}h`;
  refs.dueSoonStat.textContent = String(insights.dueSoon.length);
  refs.completionStat.textContent = `${insights.completionRate}%`;
  refs.focusModeStat.textContent = insights.focusMode;
}

function renderTodayAgenda(insights) {
  if (!insights.todaySessions.length && !insights.todayTasks.length) {
    refs.todayAgenda.innerHTML = `<div class="empty-state">Today is open. Add a study block or let auto-plan place your most urgent work.</div>`;
    return;
  }

  const sessionMarkup = insights.todaySessions.map((session) => `
    <article class="agenda-item">
      <strong>${escapeHtml(session.title)}</strong>
      <div class="agenda-subline">${escapeHtml(session.subject)} - ${formatTime(session.start)}-${formatTime(session.end)} - ${MODE_LABEL[session.mode] || "Study block"}</div>
    </article>
  `).join("");

  const taskMarkup = insights.todayTasks.map((task) => `
    <article class="agenda-item">
      <strong>${escapeHtml(task.title)}</strong>
      <div class="agenda-subline">${escapeHtml(task.subject)} - due ${formatDueDate(task.dueDate)} - ${task.minutes} min</div>
    </article>
  `).join("");

  refs.todayAgenda.innerHTML = sessionMarkup + taskMarkup;
}

function renderTimetable() {
  const pieces = [];
  pieces.push(`<div class="time-label" style="grid-column: 1; grid-row: 1;"></div>`);

  SHORT_DAYS.forEach((day, index) => {
    pieces.push(`
      <div class="day-label" style="grid-column: ${index + 2}; grid-row: 1;">
        <strong>${day}</strong>
      </div>
    `);
  });

  for (let slot = 0; slot < TOTAL_SLOTS; slot += 1) {
    const row = slot + 2;
    const minutes = START_MINUTES + slot * SLOT_MINUTES;
    pieces.push(`
      <div class="time-label" style="grid-column: 1; grid-row: ${row};">
        ${slot % 2 === 0 ? formatMinutes(minutes) : ""}
      </div>
    `);

    for (let dayIndex = 0; dayIndex < DAY_NAMES.length; dayIndex += 1) {
      pieces.push(`
        <div class="grid-slot" style="grid-column: ${dayIndex + 2}; grid-row: ${row};"></div>
      `);
    }
  }

  state.sessions.forEach((session) => {
    const dayIndex = DAY_NAMES.indexOf(session.day);
    const startSlot = Math.max(0, Math.floor((toMinutes(session.start) - START_MINUTES) / SLOT_MINUTES));
    const span = Math.max(1, Math.ceil((toMinutes(session.end) - toMinutes(session.start)) / SLOT_MINUTES));

    if (dayIndex < 0 || startSlot >= TOTAL_SLOTS) {
      return;
    }

    pieces.push(`
      <article
        class="session-chip ${session.mode}"
        style="grid-column: ${dayIndex + 2}; grid-row: ${startSlot + 2} / span ${span};"
        title="${escapeAttribute(`${session.title} (${session.subject})`)}"
      >
        <strong>${escapeHtml(session.title)}</strong>
        <span>${escapeHtml(session.subject)}</span>
        <span>${formatTime(session.start)}-${formatTime(session.end)}</span>
      </article>
    `);
  });

  refs.timetableGrid.innerHTML = pieces.join("");
}

function renderUpcomingSessions() {
  const ordered = state.sessions
    .slice()
    .sort(compareSessionsByCurrentWeek)
    .slice(0, 6);

  if (!ordered.length) {
    refs.upcomingSessions.innerHTML = `<div class="empty-state">No sessions yet. Add one from the form or auto-plan from the task list.</div>`;
    return;
  }

  refs.upcomingSessions.innerHTML = ordered.map((session) => `
    <article class="upcoming-card">
      <div>
        <strong>${escapeHtml(session.title)}</strong>
        <p>${escapeHtml(session.subject)} - ${session.day} - ${formatTime(session.start)}-${formatTime(session.end)}</p>
      </div>
      <div class="upcoming-actions">
        <span class="mode-pill">${MODE_LABEL[session.mode] || "Study block"}</span>
        <button class="secondary-button small-button" data-remove-session="${session.id}" type="button">Remove</button>
      </div>
    </article>
  `).join("");
}

function renderFocusQueue(insights) {
  if (!insights.focusQueue.length) {
    refs.focusQueue.innerHTML = `<div class="empty-state">Everything looks planned. Add a task to get a fresh smart suggestion.</div>`;
    return;
  }

  refs.focusQueue.innerHTML = insights.focusQueue.map((item) => `
    <article class="focus-card">
      <div class="task-topline">
        <div>
          <strong>${escapeHtml(item.task.title)}</strong>
          <p>${escapeHtml(item.task.subject)} - ${item.task.minutes} min - due ${formatDueDate(item.task.dueDate)}</p>
        </div>
        <span class="task-pill ${item.task.priority}">${capitalize(item.task.priority)}</span>
      </div>
      <p>${item.reason}</p>
      <div class="focus-actions">
        <span class="focus-chip">${item.suggestion}</span>
        <button class="secondary-button small-button" data-plan-task="${item.task.id}" type="button">Plan this task</button>
      </div>
    </article>
  `).join("");
}

function renderTasks() {
  const tasks = getFilteredTasks();

  if (!tasks.length) {
    refs.taskList.innerHTML = `<div class="empty-state">No tasks in this view yet.</div>`;
    return;
  }

  refs.taskList.innerHTML = tasks.map((task) => {
    const planned = hasLinkedSession(task.id);
    return `
      <article class="task-card ${task.done ? "done" : ""}">
        <div class="task-topline">
          <div class="task-title-row">
            <button class="toggle-task ${task.done ? "is-done" : ""}" data-action="toggle" data-id="${task.id}" type="button" aria-label="Toggle task completion">
              ${task.done ? "Done" : "Mark"}
            </button>
            <div>
              <h3>${escapeHtml(task.title)}</h3>
              <div class="task-meta">${escapeHtml(task.subject)} - due ${formatDueDate(task.dueDate)} - ${task.minutes} min</div>
            </div>
          </div>
          <span class="task-pill ${task.priority}">${capitalize(task.priority)}</span>
        </div>
        <div class="task-actions">
          <span class="mode-pill">${planned ? "Linked to timetable" : "Not scheduled yet"}</span>
          <button class="secondary-button small-button" data-action="plan" data-id="${task.id}" type="button">Plan</button>
          <button class="secondary-button small-button" data-action="delete" data-id="${task.id}" type="button">Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderBalance(insights) {
  refs.balanceList.innerHTML = DAY_NAMES.map((day) => {
    const minutes = insights.dayLoad[day] || 0;
    const width = Math.min(100, Math.round((minutes / 240) * 100));
    const label = minutes >= 180 ? "Heavy" : minutes >= 90 ? "Balanced" : "Light";
    return `
      <article class="balance-item">
        <strong>${day}</strong>
        <div class="mini-note">${(minutes / 60).toFixed(1)}h scheduled - ${label}</div>
        <div class="load-bar" aria-hidden="true"><span style="width: ${width}%"></span></div>
      </article>
    `;
  }).join("");
}

function renderDeadlines(insights) {
  if (!insights.dueSoon.length) {
    refs.deadlineList.innerHTML = `<div class="empty-state">No close deadlines right now.</div>`;
    return;
  }

  refs.deadlineList.innerHTML = insights.dueSoon.map((task) => `
    <article class="deadline-card">
      <strong>${escapeHtml(task.title)}</strong>
      <p>${escapeHtml(task.subject)} - due ${formatDueDate(task.dueDate)} - ${capitalize(task.priority)} priority</p>
    </article>
  `).join("");
}

function renderTimer() {
  const timer = buildTimerState(state.focusTimer);
  const isPaused = !timer.running && timer.remainingSeconds > 0 && timer.remainingSeconds < timer.durationSeconds;
  const isDone = !timer.running && timer.remainingSeconds === 0 && Boolean(timer.lastCompletedAt);
  const isReady = !timer.running && timer.remainingSeconds === timer.durationSeconds;

  refs.timerClock.textContent = formatClock(timer.remainingSeconds);
  refs.timerLabelDisplay.textContent = timer.label || "Deep focus block";

  if (timer.running) {
    refs.timerMeta.textContent = `Ends at ${formatClockTime(timer.endsAt)}. Stored in SQL whenever the Java server is running.`;
  } else if (isPaused) {
    refs.timerMeta.textContent = `${formatDurationWords(timer.remainingSeconds)} left. Resume when you are ready to continue.`;
  } else if (isDone) {
    refs.timerMeta.textContent = `Last completed at ${formatTimestamp(timer.lastCompletedAt)}. Reset or choose a new custom duration.`;
  } else {
    refs.timerMeta.textContent = `Set 1 hour, 2 hours, or any custom study duration you need.`;
  }

  refs.timerStatePill.textContent = timer.running ? "Running" : isPaused ? "Paused" : isDone ? "Done" : "Ready";
  refs.timerStatePill.className = `timer-state-pill ${timer.running ? "running" : isPaused ? "paused" : isDone ? "done" : "ready"}`;

  refs.timerStartButton.disabled = timer.running;
  refs.timerPauseButton.disabled = !timer.running;
  refs.timerResumeButton.disabled = timer.running || timer.remainingSeconds <= 0 || timer.remainingSeconds === timer.durationSeconds;
  refs.timerResetButton.disabled = timer.running ? false : timer.remainingSeconds === timer.durationSeconds && !timer.lastCompletedAt;

  refs.presetButtons.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.durationSeconds) === timer.durationSeconds);
  });
}

function updateSyncPill() {
  if (backendStatus === "connecting") {
    refs.syncPill.textContent = "Connecting to Java + SQL...";
    refs.syncPill.className = "sync-pill";
    return;
  }

  refs.syncPill.textContent = backendStatus === "online" ? "Java + SQL live" : "Preview cache only";
  refs.syncPill.className = `sync-pill ${backendStatus === "online" ? "online" : "offline"}`;
}

function buildInsights() {
  const todayName = getTodayDayName();
  const timer = buildTimerState(state.focusTimer);
  const totalSessionMinutes = state.sessions.reduce((sum, session) => sum + durationMinutes(session), 0);
  const pendingTasks = state.tasks.filter((task) => !task.done);
  const completedTasks = state.tasks.filter((task) => task.done);
  const completionRate = state.tasks.length ? Math.round((completedTasks.length / state.tasks.length) * 100) : 0;
  const dayLoad = DAY_NAMES.reduce((acc, day) => {
    acc[day] = state.sessions
      .filter((session) => session.day === day)
      .reduce((sum, session) => sum + durationMinutes(session), 0);
    return acc;
  }, {});

  const dueSoon = pendingTasks
    .slice()
    .sort((a, b) => daysUntil(a.dueDate) - daysUntil(b.dueDate))
    .filter((task) => daysUntil(task.dueDate) <= 3)
    .slice(0, 4);

  const focusQueue = pendingTasks
    .slice()
    .sort((a, b) => scoreTask(b) - scoreTask(a))
    .slice(0, 4)
    .map((task) => {
      const suggestion = findBestSlot(task);
      return {
        task,
        reason: explainUrgency(task),
        suggestion: suggestion ? `${suggestion.day} ${formatTime(suggestion.start)}` : "Needs manual space"
      };
    });

  const todaySessions = state.sessions
    .filter((session) => session.day === todayName)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

  const todayTasks = pendingTasks
    .filter((task) => daysUntil(task.dueDate) <= 1)
    .slice(0, 3);

  const averageDailyMinutes = Object.values(dayLoad).reduce((sum, item) => sum + item, 0) / DAY_NAMES.length;
  const heavyDays = Object.values(dayLoad).filter((item) => item >= 180).length;
  const focusMode = timer.running ? "Timer live" : heavyDays >= 3 ? "Intensity week" : averageDailyMinutes >= 90 ? "Strong rhythm" : "Balanced";

  return {
    totalSessionMinutes,
    completionRate,
    dueSoon,
    focusQueue,
    todaySessions,
    todayTasks,
    dayLoad,
    focusMode
  };
}

function autoPlanTasks(singleTaskId = null) {
  const candidates = state.tasks
    .filter((task) => !task.done)
    .filter((task) => !hasLinkedSession(task.id))
    .filter((task) => !singleTaskId || task.id === singleTaskId)
    .sort((a, b) => scoreTask(b) - scoreTask(a));

  const selected = singleTaskId ? candidates.slice(0, 1) : candidates.slice(0, 3);
  const created = [];

  selected.forEach((task) => {
    const suggestion = findBestSlot(task);
    if (!suggestion) {
      return;
    }

    const duration = normalizeDuration(task.minutes);
    const startMinutes = toMinutes(suggestion.start);
    const endMinutes = startMinutes + duration;

    state.sessions.push({
      id: createId("auto"),
      title: task.title,
      subject: task.subject,
      day: suggestion.day,
      start: fromMinutes(startMinutes),
      end: fromMinutes(endMinutes),
      mode: "auto",
      linkedTaskId: task.id
    });

    created.push(task);
  });

  if (!created.length) {
    return false;
  }

  sortSessions();
  return true;
}

function populateDayOptions() {
  refs.sessionDay.innerHTML = DAY_NAMES.map((day) => `<option value="${day}">${day}</option>`).join("");
}

function applyDefaultFormValues() {
  refs.sessionDay.value = getTodayDayName();
  refs.sessionStart.value = "17:00";
  refs.sessionEnd.value = "18:30";
  refs.taskDueDate.value = offsetDateString(1);
}

function getFilteredTasks() {
  if (taskFilter === "done") {
    return state.tasks.filter((task) => task.done);
  }

  if (taskFilter === "planned") {
    return state.tasks.filter((task) => !task.done && hasLinkedSession(task.id));
  }

  if (taskFilter === "all") {
    return state.tasks.slice();
  }

  return state.tasks.filter((task) => !task.done);
}

function findBestSlot(task) {
  const duration = normalizeDuration(task.minutes);
  const orderedDays = getRollingDayNames();
  const existingByDay = DAY_NAMES.reduce((acc, day) => {
    acc[day] = state.sessions
      .filter((session) => session.day === day)
      .slice()
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    return acc;
  }, {});

  let best = null;

  orderedDays.forEach((day, dayOffset) => {
    const latestDueOffset = Math.max(daysUntil(task.dueDate), 0);
    if (dayOffset > latestDueOffset + 1) {
      return;
    }

    const daySessions = existingByDay[day];
    const preferredStarts = [7 * 60, 8 * 60 + 30, 10 * 60, 14 * 60, 16 * 60, 18 * 60];
    const candidateStarts = preferredStarts.concat(buildFallbackStarts());

    candidateStarts.forEach((startMinutes) => {
      const endMinutes = startMinutes + duration;
      if (endMinutes > END_MINUTES) {
        return;
      }

      if (!fitsBetweenSessions(daySessions, startMinutes, endMinutes)) {
        return;
      }

      const plannedMinutes = daySessions.reduce((sum, session) => sum + durationMinutes(session), 0);
      const urgencyPenalty = Math.max(0, dayOffset - Math.max(daysUntil(task.dueDate), 0));
      const timePenalty = startMinutes >= 19 * 60 ? 24 : startMinutes <= 7 * 60 ? 12 : 0;
      const score = plannedMinutes + dayOffset * 18 + urgencyPenalty * 60 + timePenalty - PRIORITY_WEIGHT[task.priority] * 16;

      if (!best || score < best.score) {
        best = { day, start: fromMinutes(startMinutes), score };
      }
    });
  });

  return best;
}

function fitsBetweenSessions(daySessions, startMinutes, endMinutes) {
  return daySessions.every((session) => {
    const sessionStart = toMinutes(session.start);
    const sessionEnd = toMinutes(session.end);
    return endMinutes <= sessionStart || startMinutes >= sessionEnd;
  });
}

function buildFallbackStarts() {
  const starts = [];
  for (let minutes = 7 * 60; minutes <= 19 * 60; minutes += SLOT_MINUTES) {
    starts.push(minutes);
  }
  return starts;
}

function hasLinkedSession(taskId) {
  return state.sessions.some((session) => session.linkedTaskId === taskId);
}

function durationMinutes(session) {
  return toMinutes(session.end) - toMinutes(session.start);
}

function sortSessions() {
  state.sessions.sort((a, b) => {
    const dayDiff = DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day);
    if (dayDiff !== 0) {
      return dayDiff;
    }
    return toMinutes(a.start) - toMinutes(b.start);
  });
}

function compareSessionsByCurrentWeek(a, b) {
  const order = getRollingDayNames();
  const dayDiff = order.indexOf(a.day) - order.indexOf(b.day);
  if (dayDiff !== 0) {
    return dayDiff;
  }
  return toMinutes(a.start) - toMinutes(b.start);
}

function scoreTask(task) {
  const dueIn = daysUntil(task.dueDate);
  const dueScore = dueIn < 0 ? 6 : dueIn === 0 ? 5 : dueIn === 1 ? 4 : dueIn <= 3 ? 3 : 1;
  const scheduleScore = hasLinkedSession(task.id) ? -2 : 0;
  return PRIORITY_WEIGHT[task.priority] * 3 + dueScore + scheduleScore + Math.min(task.minutes / 30, 4);
}

function explainUrgency(task) {
  const dueIn = daysUntil(task.dueDate);
  if (dueIn < 0) {
    return "Already overdue, so it should land in the next open block.";
  }
  if (dueIn === 0) {
    return "Due today. A short protected block beats trying to squeeze it in later.";
  }
  if (dueIn === 1) {
    return "Due tomorrow, which makes this one the easiest to regret if it slips.";
  }
  if (task.priority === "high") {
    return "High priority and still unscheduled, so it deserves a named place in the week.";
  }
  return "Moderate deadline pressure with enough study time to schedule cleanly now.";
}

function getRollingDayNames() {
  const todayIndex = DAY_NAMES.indexOf(getTodayDayName());
  return DAY_NAMES.map((_, index) => DAY_NAMES[(todayIndex + index) % DAY_NAMES.length]);
}

function getTodayDayName() {
  const today = new Date().getDay();
  const mapped = today === 0 ? 6 : today - 1;
  return DAY_NAMES[mapped];
}

function daysUntil(dateString) {
  if (!isValidDateString(dateString)) {
    return 999;
  }

  const today = startOfDay(new Date());
  const target = startOfDay(parseLocalDate(dateString));
  const diff = target.getTime() - today.getTime();
  return Math.round(diff / 86400000);
}

function offsetDateString(offset) {
  const base = new Date();
  base.setDate(base.getDate() + offset);
  return [
    base.getFullYear(),
    String(base.getMonth() + 1).padStart(2, "0"),
    String(base.getDate()).padStart(2, "0")
  ].join("-");
}

function startOfDay(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function normalizeDuration(minutes) {
  return Math.max(30, Math.min(120, Math.ceil(minutes / 30) * 30));
}

function formatLongDate(date) {
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function formatDueDate(dateString) {
  const distance = daysUntil(dateString);
  if (distance < 0) {
    return `overdue by ${Math.abs(distance)} day${Math.abs(distance) === 1 ? "" : "s"}`;
  }
  if (distance === 0) {
    return "today";
  }
  if (distance === 1) {
    return "tomorrow";
  }
  if (!isValidDateString(dateString)) {
    return "no date";
  }
  return parseLocalDate(dateString).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return formatTime(`${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`);
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const leftover = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(leftover).padStart(2, "0")}`;
}

function formatClockTime(isoString) {
  if (!isoString) {
    return "soon";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "soon";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return "just now";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDurationWords(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (!parts.length) {
    parts.push("less than a minute");
  }
  return parts.join(" ");
}

function toMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function fromMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function parseLocalDate(dateString) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultState() {
  return {
    sessions: [
      { id: "s1", title: "Calculus drills", subject: "Math", day: "Monday", start: "07:30", end: "09:00", mode: "deep", linkedTaskId: null },
      { id: "s2", title: "Mechanics lecture", subject: "Physics", day: "Monday", start: "11:00", end: "12:30", mode: "class", linkedTaskId: null },
      { id: "s3", title: "Organic chemistry review", subject: "Chemistry", day: "Tuesday", start: "16:00", end: "17:30", mode: "review", linkedTaskId: null },
      { id: "s4", title: "Lab write-up", subject: "Biology", day: "Wednesday", start: "14:30", end: "16:00", mode: "lab", linkedTaskId: null },
      { id: "s5", title: "History reading sprint", subject: "History", day: "Thursday", start: "18:00", end: "19:30", mode: "deep", linkedTaskId: null },
      { id: "s6", title: "Weekly recap", subject: "Mixed subjects", day: "Saturday", start: "10:00", end: "11:30", mode: "review", linkedTaskId: null }
    ],
    tasks: [
      { id: "t1", title: "Finish calculus worksheet", subject: "Math", dueDate: offsetDateString(1), minutes: 90, priority: "high", done: false },
      { id: "t2", title: "Summarize chemistry chapter 5", subject: "Chemistry", dueDate: offsetDateString(2), minutes: 75, priority: "medium", done: false },
      { id: "t3", title: "Prepare biology lab observations", subject: "Biology", dueDate: offsetDateString(3), minutes: 60, priority: "high", done: false },
      { id: "t4", title: "Read history source notes", subject: "History", dueDate: offsetDateString(5), minutes: 45, priority: "low", done: false },
      { id: "t5", title: "Update class binder", subject: "General", dueDate: offsetDateString(-1), minutes: 30, priority: "medium", done: true }
    ],
    focusTimer: {
      label: "Deep focus block",
      durationSeconds: 3600,
      remainingSeconds: 3600,
      running: false,
      startedAt: null,
      endsAt: null,
      lastCompletedAt: null
    }
  };
}

function buildTimerState(input) {
  const base = {
    label: "Deep focus block",
    durationSeconds: 3600,
    remainingSeconds: 3600,
    running: false,
    startedAt: null,
    endsAt: null,
    lastCompletedAt: null,
    ...(input || {})
  };

  const durationSeconds = clampNumber(Math.round(Number(base.durationSeconds) || 3600), 60, 43200);
  let remainingSeconds = clampNumber(Math.round(Number(base.remainingSeconds) || durationSeconds), 0, durationSeconds);
  let running = Boolean(base.running);
  let startedAt = normalizeIsoString(base.startedAt);
  let endsAt = normalizeIsoString(base.endsAt);
  let lastCompletedAt = normalizeIsoString(base.lastCompletedAt);
  const label = String(base.label || "Deep focus block").trim() || "Deep focus block";

  if (running && endsAt) {
    const millisLeft = new Date(endsAt).getTime() - Date.now();
    remainingSeconds = Math.max(0, Math.ceil(millisLeft / 1000));
    if (remainingSeconds <= 0) {
      running = false;
      remainingSeconds = 0;
      startedAt = null;
      endsAt = null;
      lastCompletedAt = lastCompletedAt || new Date().toISOString();
    }
  } else if (running && !endsAt) {
    running = false;
  }

  if (!running) {
    startedAt = null;
    endsAt = null;
    if (remainingSeconds === 0 && !lastCompletedAt) {
      remainingSeconds = durationSeconds;
    }
  }

  return {
    label,
    durationSeconds,
    remainingSeconds,
    running,
    startedAt,
    endsAt,
    lastCompletedAt
  };
}

function normalizeState(input) {
  const source = input || {};
  return {
    sessions: Array.isArray(source.sessions)
      ? source.sessions.map((session) => ({
          id: String(session.id || createId("session")),
          title: String(session.title || "").trim(),
          subject: String(session.subject || "").trim(),
          day: DAY_NAMES.includes(session.day) ? session.day : "Monday",
          start: isValidTimeString(session.start) ? session.start : "09:00",
          end: isValidTimeString(session.end) ? session.end : "10:00",
          mode: MODE_LABEL[session.mode] ? session.mode : "deep",
          linkedTaskId: session.linkedTaskId ? String(session.linkedTaskId) : null
        }))
      : [],
    tasks: Array.isArray(source.tasks)
      ? source.tasks.map((task) => ({
          id: String(task.id || createId("task")),
          title: String(task.title || "").trim(),
          subject: String(task.subject || "").trim(),
          dueDate: isValidDateString(task.dueDate) ? task.dueDate : offsetDateString(1),
          minutes: clampNumber(Number(task.minutes) || 60, 15, 480),
          priority: PRIORITY_WEIGHT[task.priority] ? task.priority : "medium",
          done: Boolean(task.done)
        }))
      : [],
    focusTimer: buildTimerState(source.focusTimer)
  };
}

function serializeState(currentState) {
  const normalized = normalizeState(currentState);
  return {
    sessions: normalized.sessions.map((session) => ({ ...session })),
    tasks: normalized.tasks.map((task) => ({ ...task })),
    focusTimer: { ...normalized.focusTimer }
  };
}

function loadCachedState() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function saveCachedState(currentState) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(serializeState(currentState)));
  } catch (error) {
    console.error(error);
  }
}

function syncTimerInputsFromState() {
  const timer = buildTimerState(state.focusTimer);
  refs.timerLabelInput.value = timer.label;
  refs.timerHours.value = String(Math.floor(timer.durationSeconds / 3600));
  refs.timerMinutes.value = String(Math.floor((timer.durationSeconds % 3600) / 60));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error((payload && payload.message) || `Request failed with status ${response.status}`);
  }

  return payload;
}

function setStatus(message) {
  refs.plannerStatus.textContent = message;
}

function isValidTimeString(value) {
  return /^\d{2}:\d{2}$/.test(value || "");
}

function normalizeIsoString(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

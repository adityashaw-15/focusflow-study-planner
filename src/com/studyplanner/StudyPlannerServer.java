package com.studyplanner;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;

public final class StudyPlannerServer {
    private static final ObjectMapper JSON = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    private static final Set<String> DAYS = Set.of("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday");
    private static final Set<String> MODES = Set.of("deep", "review", "class", "lab", "auto");
    private static final Set<String> PRIORITIES = Set.of("high", "medium", "low");
    private static final int DEFAULT_PORT = Integer.parseInt(
            System.getProperty("studyplanner.port", System.getenv().getOrDefault("PORT", "8090"))
    );

    private final Path projectRoot;
    private final Path databaseFile;
    private final String jdbcUrl;

    private StudyPlannerServer(Path projectRoot) {
        this.projectRoot = projectRoot.toAbsolutePath().normalize();
        this.databaseFile = this.projectRoot.resolve("data").resolve("studyplanner");
        this.jdbcUrl = "jdbc:h2:file:" + databaseFile.toString().replace("\\", "/") + ";DB_CLOSE_ON_EXIT=FALSE";
    }

    public static void main(String[] args) throws Exception {
        Path root = resolveProjectRoot();
        Files.createDirectories(root.resolve("data"));

        StudyPlannerServer app = new StudyPlannerServer(root);
        app.initializeDatabase();

        HttpServer server = HttpServer.create(new InetSocketAddress(DEFAULT_PORT), 0);
        server.createContext("/api/health", app::handleHealth);
        server.createContext("/api/state", app::handleState);
        server.createContext("/api/reset-demo", app::handleResetDemo);
        server.createContext("/", app::handleStaticFile);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();

        System.out.println("Study Planner running at http://127.0.0.1:" + DEFAULT_PORT);
        System.out.println("Project root: " + root);
        System.out.println("Database file: " + app.databaseFile + ".mv.db");
    }

    private static Path resolveProjectRoot() {
        String explicit = System.getProperty("studyplanner.root");
        if (explicit != null && !explicit.isBlank()) {
            Path configured = Paths.get(explicit).toAbsolutePath().normalize();
            if (Files.exists(configured.resolve("index.html"))) {
                return configured;
            }
        }

        Path current = Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize();
        Path cursor = current;

        while (cursor != null) {
            if (Files.exists(cursor.resolve("index.html"))) {
                return cursor;
            }
            cursor = cursor.getParent();
        }

        return current;
    }

    private void initializeDatabase() throws SQLException {
        try (Connection connection = openConnection(); Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        sort_order INT NOT NULL,
                        id VARCHAR(80) PRIMARY KEY,
                        title VARCHAR(200) NOT NULL,
                        subject_name VARCHAR(120) NOT NULL,
                        day_name VARCHAR(20) NOT NULL,
                        start_time VARCHAR(5) NOT NULL,
                        end_time VARCHAR(5) NOT NULL,
                        mode_name VARCHAR(20) NOT NULL,
                        linked_task_id VARCHAR(80)
                    )
                    """);

            statement.execute("""
                    CREATE TABLE IF NOT EXISTS tasks (
                        sort_order INT NOT NULL,
                        id VARCHAR(80) PRIMARY KEY,
                        title VARCHAR(220) NOT NULL,
                        subject_name VARCHAR(120) NOT NULL,
                        due_date VARCHAR(10) NOT NULL,
                        minutes_needed INT NOT NULL,
                        priority_name VARCHAR(10) NOT NULL,
                        done BOOLEAN NOT NULL
                    )
                    """);

            statement.execute("""
                    CREATE TABLE IF NOT EXISTS focus_timer (
                        timer_key VARCHAR(20) PRIMARY KEY,
                        label VARCHAR(200) NOT NULL,
                        duration_seconds INT NOT NULL,
                        remaining_seconds INT NOT NULL,
                        running BOOLEAN NOT NULL,
                        started_at VARCHAR(40),
                        ends_at VARCHAR(40),
                        last_completed_at VARCHAR(40)
                    )
                    """);
        }

        seedDemoStateIfEmpty();
    }

    private void seedDemoStateIfEmpty() throws SQLException {
        try (Connection connection = openConnection(); Statement statement = connection.createStatement()) {
            int sessionCount = countRows(statement, "sessions");
            int taskCount = countRows(statement, "tasks");
            int timerCount = countRows(statement, "focus_timer");

            if (sessionCount == 0 && taskCount == 0 && timerCount == 0) {
                saveState(createDefaultState());
            }
        }
    }

    private int countRows(Statement statement, String table) throws SQLException {
        try (ResultSet resultSet = statement.executeQuery("SELECT COUNT(*) FROM " + table)) {
            resultSet.next();
            return resultSet.getInt(1);
        }
    }

    private Connection openConnection() throws SQLException {
        return DriverManager.getConnection(jdbcUrl, "sa", "");
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        addCorsHeaders(exchange.getResponseHeaders());
        if (!allowOptions(exchange)) {
            return;
        }

        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendJson(exchange, 405, new MessageResponse("Method not allowed"));
            return;
        }

        sendJson(exchange, 200, new HealthResponse(
                "ok",
                true,
                Instant.now().toString(),
                databaseFile.toString() + ".mv.db"
        ));
    }

    private void handleState(HttpExchange exchange) throws IOException {
        addCorsHeaders(exchange.getResponseHeaders());
        if (!allowOptions(exchange)) {
            return;
        }

        try {
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 200, loadState());
                return;
            }

            if ("PUT".equalsIgnoreCase(exchange.getRequestMethod())) {
                AppState incoming = readJson(exchange, AppState.class);
                AppState normalized = validateAndNormalizeState(incoming);
                saveState(normalized);
                sendJson(exchange, 200, loadState());
                return;
            }

            sendJson(exchange, 405, new MessageResponse("Method not allowed"));
        } catch (ValidationException exception) {
            sendJson(exchange, 400, new MessageResponse(exception.getMessage()));
        } catch (Exception exception) {
            exception.printStackTrace();
            sendJson(exchange, 500, new MessageResponse("Server error while reading or saving planner state."));
        }
    }

    private void handleResetDemo(HttpExchange exchange) throws IOException {
        addCorsHeaders(exchange.getResponseHeaders());
        if (!allowOptions(exchange)) {
            return;
        }

        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendJson(exchange, 405, new MessageResponse("Method not allowed"));
            return;
        }

        try {
            saveState(createDefaultState());
            sendJson(exchange, 200, loadState());
        } catch (Exception exception) {
            exception.printStackTrace();
            sendJson(exchange, 500, new MessageResponse("Server error while restoring demo planner data."));
        }
    }

    private void handleStaticFile(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod()) && !"HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendPlain(exchange, 405, "Method not allowed");
            return;
        }

        String requestPath = exchange.getRequestURI().getPath();
        if (requestPath == null || "/".equals(requestPath) || requestPath.isBlank()) {
            requestPath = "/index.html";
        }

        Path file = projectRoot.resolve(requestPath.substring(1)).normalize();
        if (!file.startsWith(projectRoot) || Files.isDirectory(file) || !Files.exists(file)) {
            sendPlain(exchange, 404, "File not found");
            return;
        }

        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType(file));
        headers.set("Cache-Control", "no-store");
        long length = Files.size(file);
        exchange.sendResponseHeaders(200, "HEAD".equalsIgnoreCase(exchange.getRequestMethod()) ? -1 : length);

        if (!"HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            try (OutputStream body = exchange.getResponseBody()) {
                Files.copy(file, body);
            }
        }
    }

    private boolean allowOptions(HttpExchange exchange) throws IOException {
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            return false;
        }
        return true;
    }

    private AppState loadState() throws SQLException {
        try (Connection connection = openConnection()) {
            List<SessionItem> sessions = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("""
                    SELECT id, title, subject_name, day_name, start_time, end_time, mode_name, linked_task_id
                    FROM sessions
                    ORDER BY sort_order
                    """);
                 ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    sessions.add(new SessionItem(
                            resultSet.getString("id"),
                            resultSet.getString("title"),
                            resultSet.getString("subject_name"),
                            resultSet.getString("day_name"),
                            resultSet.getString("start_time"),
                            resultSet.getString("end_time"),
                            resultSet.getString("mode_name"),
                            resultSet.getString("linked_task_id")
                    ));
                }
            }

            List<TaskItem> tasks = new ArrayList<>();
            try (PreparedStatement statement = connection.prepareStatement("""
                    SELECT id, title, subject_name, due_date, minutes_needed, priority_name, done
                    FROM tasks
                    ORDER BY sort_order
                    """);
                 ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    tasks.add(new TaskItem(
                            resultSet.getString("id"),
                            resultSet.getString("title"),
                            resultSet.getString("subject_name"),
                            resultSet.getString("due_date"),
                            resultSet.getInt("minutes_needed"),
                            resultSet.getString("priority_name"),
                            resultSet.getBoolean("done")
                    ));
                }
            }

            FocusTimerState timer = null;
            try (PreparedStatement statement = connection.prepareStatement("""
                    SELECT label, duration_seconds, remaining_seconds, running, started_at, ends_at, last_completed_at
                    FROM focus_timer
                    WHERE timer_key = 'main'
                    """);
                 ResultSet resultSet = statement.executeQuery()) {
                if (resultSet.next()) {
                    timer = new FocusTimerState(
                            resultSet.getString("label"),
                            resultSet.getInt("duration_seconds"),
                            resultSet.getInt("remaining_seconds"),
                            resultSet.getBoolean("running"),
                            resultSet.getString("started_at"),
                            resultSet.getString("ends_at"),
                            resultSet.getString("last_completed_at")
                    );
                }
            }

            FocusTimerState normalizedTimer = normalizeTimerState(timer);
            if (!normalizedTimer.equals(timer)) {
                persistTimer(connection, normalizedTimer);
            }

            return new AppState(sessions, tasks, normalizedTimer);
        }
    }

    private void saveState(AppState state) throws SQLException {
        AppState normalized = validateAndNormalizeState(state);

        try (Connection connection = openConnection()) {
            connection.setAutoCommit(false);
            try {
                try (Statement statement = connection.createStatement()) {
                    statement.executeUpdate("DELETE FROM sessions");
                    statement.executeUpdate("DELETE FROM tasks");
                    statement.executeUpdate("DELETE FROM focus_timer");
                }

                try (PreparedStatement statement = connection.prepareStatement("""
                        INSERT INTO sessions (sort_order, id, title, subject_name, day_name, start_time, end_time, mode_name, linked_task_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """)) {
                    for (int index = 0; index < normalized.sessions().size(); index += 1) {
                        SessionItem session = normalized.sessions().get(index);
                        statement.setInt(1, index);
                        statement.setString(2, session.id());
                        statement.setString(3, session.title());
                        statement.setString(4, session.subject());
                        statement.setString(5, session.day());
                        statement.setString(6, session.start());
                        statement.setString(7, session.end());
                        statement.setString(8, session.mode());
                        statement.setString(9, session.linkedTaskId());
                        statement.addBatch();
                    }
                    statement.executeBatch();
                }

                try (PreparedStatement statement = connection.prepareStatement("""
                        INSERT INTO tasks (sort_order, id, title, subject_name, due_date, minutes_needed, priority_name, done)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """)) {
                    for (int index = 0; index < normalized.tasks().size(); index += 1) {
                        TaskItem task = normalized.tasks().get(index);
                        statement.setInt(1, index);
                        statement.setString(2, task.id());
                        statement.setString(3, task.title());
                        statement.setString(4, task.subject());
                        statement.setString(5, task.dueDate());
                        statement.setInt(6, task.minutes());
                        statement.setString(7, task.priority());
                        statement.setBoolean(8, task.done());
                        statement.addBatch();
                    }
                    statement.executeBatch();
                }

                persistTimer(connection, normalized.focusTimer());
                connection.commit();
            } catch (Exception exception) {
                connection.rollback();
                throw exception;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private void persistTimer(Connection connection, FocusTimerState timer) throws SQLException {
        FocusTimerState safeTimer = normalizeTimerState(timer);
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO focus_timer (timer_key, label, duration_seconds, remaining_seconds, running, started_at, ends_at, last_completed_at)
                VALUES ('main', ?, ?, ?, ?, ?, ?, ?)
                """)) {
            statement.setString(1, safeTimer.label());
            statement.setInt(2, safeTimer.durationSeconds());
            statement.setInt(3, safeTimer.remainingSeconds());
            statement.setBoolean(4, safeTimer.running());
            statement.setString(5, safeTimer.startedAt());
            statement.setString(6, safeTimer.endsAt());
            statement.setString(7, safeTimer.lastCompletedAt());
            statement.executeUpdate();
        }
    }

    private AppState createDefaultState() {
        LocalDate today = LocalDate.now();
        return new AppState(
                List.of(
                        new SessionItem("s1", "Calculus drills", "Math", "Monday", "07:30", "09:00", "deep", null),
                        new SessionItem("s2", "Mechanics lecture", "Physics", "Monday", "11:00", "12:30", "class", null),
                        new SessionItem("s3", "Organic chemistry review", "Chemistry", "Tuesday", "16:00", "17:30", "review", null),
                        new SessionItem("s4", "Lab write-up", "Biology", "Wednesday", "14:30", "16:00", "lab", null),
                        new SessionItem("s5", "History reading sprint", "History", "Thursday", "18:00", "19:30", "deep", null),
                        new SessionItem("s6", "Weekly recap", "Mixed subjects", "Saturday", "10:00", "11:30", "review", null)
                ),
                List.of(
                        new TaskItem("t1", "Finish calculus worksheet", "Math", today.plusDays(1).toString(), 90, "high", false),
                        new TaskItem("t2", "Summarize chemistry chapter 5", "Chemistry", today.plusDays(2).toString(), 75, "medium", false),
                        new TaskItem("t3", "Prepare biology lab observations", "Biology", today.plusDays(3).toString(), 60, "high", false),
                        new TaskItem("t4", "Read history source notes", "History", today.plusDays(5).toString(), 45, "low", false),
                        new TaskItem("t5", "Update class binder", "General", today.minusDays(1).toString(), 30, "medium", true)
                ),
                new FocusTimerState("Deep focus block", 3600, 3600, false, null, null, null)
        );
    }

    private AppState validateAndNormalizeState(AppState state) {
        if (state == null) {
            throw new ValidationException("Planner state was missing from the request body.");
        }

        List<SessionItem> sessions = new ArrayList<>();
        if (state.sessions() != null) {
            for (SessionItem session : state.sessions()) {
                sessions.add(validateSession(session));
            }
        }

        List<TaskItem> tasks = new ArrayList<>();
        if (state.tasks() != null) {
            for (TaskItem task : state.tasks()) {
                tasks.add(validateTask(task));
            }
        }

        FocusTimerState timer = normalizeTimerState(state.focusTimer());
        return new AppState(sessions, tasks, timer);
    }

    private SessionItem validateSession(SessionItem session) {
        if (session == null) {
            throw new ValidationException("One of the timetable sessions was empty.");
        }

        String id = requiredValue(session.id(), "A study session was missing its id.", 80);
        String title = requiredValue(session.title(), "A study session needs a title.", 200);
        String subject = requiredValue(session.subject(), "A study session needs a subject.", 120);
        String day = requiredValue(session.day(), "A study session needs a day.", 20);
        String start = requiredValue(session.start(), "A study session needs a start time.", 5);
        String end = requiredValue(session.end(), "A study session needs an end time.", 5);
        String mode = normalizeMode(session.mode());
        String linkedTaskId = optionalValue(session.linkedTaskId(), 80);

        if (!DAYS.contains(day)) {
            throw new ValidationException("Study session day must be a valid weekday name.");
        }

        try {
            LocalTime startTime = LocalTime.parse(start);
            LocalTime endTime = LocalTime.parse(end);
            if (!endTime.isAfter(startTime)) {
                throw new ValidationException("Study session end time must be later than the start time.");
            }
        } catch (DateTimeParseException exception) {
            throw new ValidationException("Study session times must use the HH:MM format.");
        }

        return new SessionItem(id, title, subject, day, start, end, mode, linkedTaskId);
    }

    private TaskItem validateTask(TaskItem task) {
        if (task == null) {
            throw new ValidationException("One of the tasks was empty.");
        }

        String id = requiredValue(task.id(), "A task was missing its id.", 80);
        String title = requiredValue(task.title(), "A task needs a title.", 220);
        String subject = requiredValue(task.subject(), "A task needs a subject.", 120);
        String dueDate = requiredValue(task.dueDate(), "A task needs a due date.", 10);
        String priority = normalizePriority(task.priority());
        int minutes = task.minutes();

        if (minutes < 15 || minutes > 480) {
            throw new ValidationException("Task study minutes must stay between 15 and 480.");
        }

        try {
            LocalDate.parse(dueDate);
        } catch (DateTimeParseException exception) {
            throw new ValidationException("Task due dates must use the YYYY-MM-DD format.");
        }

        return new TaskItem(id, title, subject, dueDate, minutes, priority, task.done());
    }

    private FocusTimerState normalizeTimerState(FocusTimerState timer) {
        FocusTimerState source = timer == null
                ? new FocusTimerState("Deep focus block", 3600, 3600, false, null, null, null)
                : timer;

        String label = optionalValue(source.label(), 200);
        if (label == null || label.isBlank()) {
            label = "Deep focus block";
        }

        int durationSeconds = clamp(source.durationSeconds(), 60, 43200);
        int remainingSeconds = clamp(source.remainingSeconds(), 0, durationSeconds);
        boolean running = source.running();
        String startedAt = normalizeInstant(source.startedAt());
        String endsAt = normalizeInstant(source.endsAt());
        String lastCompletedAt = normalizeInstant(source.lastCompletedAt());

        if (running) {
            if (remainingSeconds == 0) {
                remainingSeconds = durationSeconds;
            }

            if (endsAt == null) {
                Instant now = Instant.now();
                startedAt = now.toString();
                endsAt = now.plusSeconds(remainingSeconds).toString();
            } else {
                Instant end = Instant.parse(endsAt);
                long secondsLeft = Duration.between(Instant.now(), end).getSeconds();
                if (secondsLeft <= 0) {
                    running = false;
                    remainingSeconds = 0;
                    startedAt = null;
                    endsAt = null;
                    if (lastCompletedAt == null) {
                        lastCompletedAt = Instant.now().toString();
                    }
                } else {
                    remainingSeconds = (int) Math.min(secondsLeft, durationSeconds);
                    if (startedAt == null) {
                        startedAt = Instant.now().minusSeconds(durationSeconds - remainingSeconds).toString();
                    }
                }
            }
        } else {
            startedAt = null;
            endsAt = null;
            if (remainingSeconds == 0 && lastCompletedAt == null) {
                remainingSeconds = durationSeconds;
            }
        }

        return new FocusTimerState(label, durationSeconds, remainingSeconds, running, startedAt, endsAt, lastCompletedAt);
    }

    private String requiredValue(String value, String message, int maxLength) {
        String trimmed = optionalValue(value, maxLength);
        if (trimmed == null || trimmed.isBlank()) {
            throw new ValidationException(message);
        }
        return trimmed;
    }

    private String optionalValue(String value, int maxLength) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.length() > maxLength) {
            return trimmed.substring(0, maxLength);
        }
        return trimmed;
    }

    private String normalizeMode(String value) {
        String mode = optionalValue(value, 20);
        return MODES.contains(mode) ? mode : "deep";
    }

    private String normalizePriority(String value) {
        String priority = optionalValue(value, 10);
        return PRIORITIES.contains(priority) ? priority : "medium";
    }

    private String normalizeInstant(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value).toString();
        } catch (DateTimeParseException exception) {
            return null;
        }
    }

    private int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private <T> T readJson(HttpExchange exchange, Class<T> type) throws IOException {
        try (InputStream body = exchange.getRequestBody()) {
            return JSON.readValue(body, type);
        }
    }

    private void sendJson(HttpExchange exchange, int status, Object payload) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(payload);
        Headers headers = exchange.getResponseHeaders();
        addCorsHeaders(headers);
        headers.set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream body = exchange.getResponseBody()) {
            body.write(bytes);
        }
    }

    private void sendPlain(HttpExchange exchange, int status, String message) throws IOException {
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "text/plain; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream body = exchange.getResponseBody()) {
            body.write(bytes);
        }
    }

    private void addCorsHeaders(Headers headers) {
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        headers.set("Cache-Control", "no-store");
    }

    private String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase();
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    public record AppState(List<SessionItem> sessions, List<TaskItem> tasks, FocusTimerState focusTimer) {}
    public record SessionItem(String id, String title, String subject, String day, String start, String end, String mode, String linkedTaskId) {}
    public record TaskItem(String id, String title, String subject, String dueDate, int minutes, String priority, boolean done) {}
    public record FocusTimerState(String label, int durationSeconds, int remainingSeconds, boolean running, String startedAt, String endsAt, String lastCompletedAt) {}
    public record MessageResponse(String message) {}
    public record HealthResponse(String status, boolean databaseReady, String serverTime, String databaseFile) {}

    private static final class ValidationException extends RuntimeException {
        private ValidationException(String message) {
            super(message);
        }
    }
}

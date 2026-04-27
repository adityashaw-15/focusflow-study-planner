# Study Planner / Smart Timetable

Standalone full-stack project created in:

`C:\Users\user\Documents\New project\study-planner-smart-timetable`

## Frontend code

- `index.html`
- `styles.css`
- `app.js`

## Backend code

- `backend\src\com\studyplanner\StudyPlannerServer.java`
- `start-server.ps1`
- `start-server.cmd`
- `backend\lib\*.jar`

## Storage

The Java backend stores planner data in an on-disk H2 SQL database:

- `data\studyplanner.mv.db`

That file stays on the device, so tasks, sessions, and the focus timer survive server restarts.

## Run it

From this folder:

```powershell
.\start-server.cmd
```

Then open:

`http://127.0.0.1:8090`

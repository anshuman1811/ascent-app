# User guide

How to set Ascent up for the way you train and eat, and how to use it day to day. If you haven't installed it yet, start with **[Getting started](getting-started.md)**.

The screenshots use two made-up people, Alex and Sam.

- [Finding your way around](#finding-your-way-around)
- [Set up: targets](#set-up-targets)
- [Set up: the library](#set-up-the-library)
- [Set up: routines](#set-up-routines)
- [Set up: regimes](#set-up-regimes)
- [Daily use: workouts](#daily-use-workouts)
- [Daily use: meals](#daily-use-meals)
- [Reviewing progress](#reviewing-progress)
- [Two people, one screen](#two-people-one-screen)
- [Feedback](#feedback)

## Finding your way around

The **sidebar** takes you everywhere: **Food Log**, **Workout** and **Progress** are the three things you do most; **Library** holds the shared foods, exercises and routines; **Profile** holds your targets and weight. The **Dashboard** is today at a glance:

![Dashboard, annotated](illustrations/dashboard-annotated.png)

1. **Who's using it** — tap a name to switch person. Everything you see and log belongs to the highlighted one.
2. **Both people's day** — calories eaten against each target, with the macros underneath.
3. **Shortcuts** — log a meal, or start (or resume) a workout.
4. **Workout in progress** — jump back into a session you left.
5. **Today in detail** — the calorie ring and macro bar. The target rises on days you train by the calories you burned.
6. **Today's meals** — expand one to see what's in it, or add another. The arrows beside **Today** at the top move to other days.
7. **Feedback** — note a bug or an idea from any page.

### A sensible order

```mermaid
flowchart TD
  subgraph once["Set up once"]
    T["<b>Check your targets</b><br/>Profile → Targets"] --> L["<b>Review the library</b><br/>Library → Foods, Exercises"]
    L --> R["<b>Build routines</b><br/>Library → Routines"]
    R --> G["<b>Group them into a regime</b><br/>Workout → Regimes"]
  end
  subgraph daily["Every day"]
    M["<b>Log meals</b><br/>Food Log"]
    W["<b>Train</b><br/>Workout → Start"]
    D["<b>See the day</b><br/>Dashboard"]
  end
  subgraph weekly["Every week or two"]
    P["<b>Review progress</b><br/>Progress"]
    B["<b>Back up</b><br/>data/"]
  end
  G --> W
  M --> D
  W --> D
  D --> P
  P --> B
```

## Set up: targets

![Profile](screenshots/profile.png)

**Profile → Targets** is filled in from what you entered at onboarding, and recalculates whenever you change something.

- **Daily movement** is your background activity *excluding* workouts (steps, commute, an active job). Logged workouts are added on top each day, so don't count them here.
- **Goal** shifts the target down for a cut or up for a bulk.
- **Base daily target** is what you eat on a rest day. On a day you train, the dashboard raises the target by the calories you burned.
- **Tracked macros** — tick the ones you want on the dashboard and give each a target; **Auto-fill** suggests values.

**Profile → Weight** is where you log body weight. The latest entry is used for calorie-burn estimates, so update it now and then.

## Set up: the library

The library is shared by everyone in the household.

### Exercises

![Exercise library](screenshots/library-exercises.png)

110 exercises are included, tagged as strength, cardio, warmup or cooldown, and as **reps** or **timed**. Expand one to see its technique notes and muscle map. Use **Add Exercise** for anything missing — pick the muscles it works so it counts toward your muscle-volume chart.

### Foods

![Food library](screenshots/library-foods.png)

100 common foods are included. Add your own from the nutrition label: enter the serving size and the values for that serving, and Ascent scales them to whatever amount you log. A food can also be a **recipe** made of other foods as ingredients.

## Set up: routines

![Routines](screenshots/library-routines.png)

A routine is an ordered list of exercises with targets. Go to **Library → Routines → New Routine**, then add exercises and set for each one:

- sets and reps (or seconds, for timed exercises)
- starting weight
- rest between sets

Use the arrows to reorder, the swap icon to replace an exercise while keeping its targets, and expand the routine to see which muscles it covers overall. Each routine belongs to the person who was active when it was created.

## Set up: regimes

![Regimes](screenshots/workout-regimes.png)

A regime is a rotation of routines — Upper / Lower, Push / Pull / Legs, and so on. Create one under **Workout → Regimes → New Regime**, add your routines in order, and press **Set as active**. From then on Ascent marks the next routine in the rotation as **Up next**, so you never have to remember where you left off. It follows the order, not the calendar: skip a day and the same routine is still waiting.

## Daily use: workouts

![Starting a workout](screenshots/workout-start.png)

On **Workout → Start**, press **Start** on a routine, or choose **Ad-hoc** to build a session as you go. **Log Activity** records a walk, run or hike without the set-by-set tracking.

A session follows a simple loop:

```mermaid
flowchart LR
  S["<b>Start</b><br/>a routine"] --> X["<b>Open</b><br/>an exercise tab"]
  X --> L["<b>Log a set</b><br/>reps × weight"]
  L --> RT["<b>Rest timer</b><br/>synced across devices"]
  RT --> Q{"More sets?"}
  Q -- yes --> L
  Q -- no --> N{"More exercises?"}
  N -- yes --> X
  N -- no --> F["<b>Saved automatically</b><br/>calories and PRs recorded"]
```

![Live workout, annotated](illustrations/live-workout-annotated.png)

1. **Time and calories** so far. The workout saves itself when the last exercise is done; **Finish** ends it early.
2. **Exercise tabs** — green means done. **+** adds an exercise and the grip icon reorders them.
3. **Progress and target** for this exercise; **+ Set** adds an extra set.
4. **Last session and your PR** — the numbers to beat. The PR is the heaviest weight you've lifted for at least 4 reps and, at that weight, the most reps.
5. **Logged sets** — a set that beats your record is flagged **PR!** straight away. The pencil edits or deletes a set.
6. **Next set** — enter reps and weight and press **Log Set**. The rest timer starts on its own and keeps time on every device showing the session. **Clean rep** lets you mark a set as assisted.
7. **Technique** — how to do the move, and which muscles it works.

**Skip Remaining Sets** moves on early; a skipped exercise can be un-skipped.

Past sessions are under **Workout → History**, and every record under **Workout → PRs**.

![PRs](screenshots/workout-prs.png)

## Daily use: meals

![Food log](screenshots/food-log.png)

In **Food Log**, press **Add Meal**, pick the meal type, and add foods with a quantity. Three shortcuts make it faster:

- **Recent** — re-log things either of you ate lately with one tap.
- **AI Food Parser** — describe the meal in plain English and review what it found (needs an API key; see [Getting started](getting-started.md#ai-features)).
- **Log Meal** on the dashboard opens the same form.

Expand a meal to see or change its items. The day total at the top and the dashboard ring update as you go.

## Reviewing progress

![Progress](screenshots/progress.png)

**Progress** covers the last 12 weeks:

- **Muscle Volume** — sets per week for each muscle group, with a heatmap of the last four weeks, to spot what you're neglecting.
- **Strength Trends** — estimated one-rep max over time for each lift, with PRs starred.
- **Analyze my progress** — an optional AI-written summary of your recent training (needs an API key).

## Two people, one screen

![Split-screen](screenshots/split-screen.png)

Add `?users=1,2` to the address to show both people side by side — handy on a tablet in the kitchen or gym. Each half works independently. If you're both mid-workout, **Resume Together** on the dashboard opens both live sessions side by side.

## Feedback

The **Feedback** button in the corner of every page saves a note — a bug or an idea — along with the page you were on. Notes are stored in your own database and listed under **Feedback** in the sidebar; nothing is sent anywhere.

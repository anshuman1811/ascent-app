#!/usr/bin/env python3
"""
Downloads exercise demonstration GIFs from the hasaneyldrm/exercises-dataset
GitHub repo into client/public/exercises/ so the app works without depending on
a live CDN. The animations are (c) Gym visual - https://gymvisual.com/ and are
redistributed by that repo with permission at 180x180, on condition that the
attribution is kept; the app shows it under each GIF (ExerciseAnimation.tsx).

Also fetches the two-frame JPG pairs from yuhonas/free-exercise-db (CC0) used
for moves the GIF set doesn't cover (TWO_FRAME below).

Run: python3 server/scripts/download-exercise-gifs.py
"""
import os
import urllib.request

BASE = "https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/"
TWO_FRAME_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/"
OUT_DIR = os.path.join(os.path.dirname(__file__), "../../client/public/exercises")

# exercise name (matches LOCAL_GIFS in server/db/index.js) -> remote gif path.
# Saved as exercises/<slugify(name)>.gif. Exercises that reuse another one's file
# (Pause Squat, Face Pull (Warm-up)) aren't listed.
MAPPING = {
    "Back Squat":                "videos/0043-qXTaZnJ.gif",
    "Bench Press":                "videos/0025-EIeI8Vf.gif",
    "Close-Grip Bench Press":     "videos/0030-J6Dx1Mu.gif",
    "Deadlift":                   "videos/0032-ila4NZS.gif",
    "Romanian Deadlift":          "videos/0085-wQ2c4XD.gif",
    "Overhead Press":             "videos/1456-wdRZISl.gif",  # standing; 0091 was the seated press
    "Good Morning":               "videos/0044-XlZ4lAC.gif",
    "Bent-Over Barbell Row":      "videos/0027-eZyBC3j.gif",
    "Barbell Curl":               "videos/0031-25GPyDY.gif",
    "Barbell Lunge":              "videos/0054-t8iSghb.gif",
    "Barbell Shrug":              "videos/0095-dG7tG5y.gif",
    "Power Clean":                "videos/0648-SiWCcTN.gif",
    "Front Squat":                "videos/0042-zG0zs85.gif",
    "Zercher Squat":              "videos/0127-LSTChY9.gif",
    "Barbell Hip Thrust":         "videos/1409-qKBpF7I.gif",
    "Dumbbell Bench Press":       "videos/0289-SpYC0Kp.gif",
    "Incline Dumbbell Press":     "videos/0314-ns0SIbU.gif",
    "Dumbbell Fly":               "videos/0308-yz9nUhF.gif",
    "Dumbbell Lateral Raise":     "videos/0334-DsgkuIt.gif",
    "Dumbbell Front Raise":       "videos/0310-3eGE2JC.gif",
    "Dumbbell Rear Delt Fly":     "videos/2292-mu5Guxt.gif",
    "Dumbbell Curl":              "videos/0294-NbVPDMW.gif",
    "Hammer Curl":                "videos/0313-slDvUAU.gif",
    "Dumbbell Shoulder Press":    "videos/0405-znQUdHY.gif",
    "Dumbbell Romanian Deadlift": "videos/1459-rR0LJzx.gif",
    "Dumbbell Lunge":             "videos/0336-RRWFUcw.gif",
    "Goblet Squat":               "videos/1760-yn8yg1r.gif",
    "Dumbbell Tricep Kickback":   "videos/1739-Gi2BXfK.gif",
    "Dumbbell Pullover":          "videos/0375-9XjtHvS.gif",
    "Dumbbell Step-Up":           "videos/0431-aXtJhlg.gif",
    "Dumbbell Shrug":             "videos/0406-NJzBsGJ.gif",
    "Single-Arm Dumbbell Row":    "videos/0292-C0MA9bC.gif",
    "Kettlebell Swing":           "videos/0549-UHJlbu3.gif",
    "Kettlebell Goblet Squat":    "videos/0534-ZA8b5hc.gif",
    "Kettlebell Turkish Get-Up":  "videos/0551-Ha7SZ3y.gif",
    "Lat Pulldown (Wide Grip)":   "videos/0150-eYnzaCm.gif",  # 2330 was a standing cable-tower pulldown
    "Lat Pulldown (Close Grip)":  "videos/0818-rkg41Fb.gif",
    "Seated Cable Row":           "videos/0861-fUBheHs.gif",
    "Cable Tricep Pushdown":      "videos/0241-gAwDzB3.gif",
    "Straight-Arm Pulldown":      "videos/0238-x69MAlq.gif",
    "Cable Fly":                  "videos/0179-FVmZVhk.gif",
    "Pull-Up":                    "videos/0652-lBDjFxJ.gif",
    "Chin-Up":                    "videos/1326-T2mxWqc.gif",
    "Push-Up":                    "videos/0662-I4hDWkc.gif",
    "Dip":                        "videos/0814-X6C6i5Y.gif",
    "Inverted Row":               "videos/0499-bZGHsAZ.gif",
    "Dead Bug":                   "videos/0276-iny3m5y.gif",
    "Hanging Leg Raise":          "videos/0472-I3tsCnC.gif",
    "Hanging Knee Raise":         "videos/1764-VEcJRo2.gif",
    "Mountain Climbers":          "videos/0630-RJgzwny.gif",
    "Burpees":                    "videos/1160-dK9394r.gif",
    "Side Plank":                 "videos/0705-RKjH6Lt.gif",  # 1775 was the hip-adduction variant
    "Face Pull":                  "videos/0233-ZfyAGhK.gif",
    "Kettlebell Windmill":        "videos/0554-9Tkqa9O.gif",
    "Ab Wheel Rollout":           "videos/0857-NAgVB3t.gif",
    "Plank":                      "videos/2135-VBAWRPG.gif",
    "Incline Barbell Bench Press": "videos/0047-3TZduzM.gif",
    "Rack Pull":                  "videos/0074-za9Ni4z.gif",
    "Kettlebell Snatch":          "videos/0542-aXcUyKb.gif",
    "Kettlebell Row":             "videos/0541-g9AsZ8P.gif",
    "Kettlebell Figure-8":        "videos/0532-L4ay0PW.gif",
    "Cable Curl":                 "videos/0868-G08RZcQ.gif",
    "Cable Row (Single Arm)":     "videos/0214-vpp9Ku2.gif",
    "Pistol Squat":               "videos/1759-nqs5HGV.gif",
    "Nordic Curl":                "videos/0696-E4PwJqI.gif",
    "Running":                    "videos/0685-oLrKqDH.gif",
    "Cycling (Stationary)":       "videos/0798-a8VDgLw.gif",
    "Jump Rope":                  "videos/2612-e1e76I2.gif",
    "Inchworm":                   "videos/1471-ZgsNQ6d.gif",
    "World's Greatest Stretch":   "videos/1604-DFGXwZr.gif",
    "Glute Bridge (Bodyweight)":  "videos/3013-u0cNiij.gif",
    "Scapular Pull-Up":           "videos/0688-uTBt1HV.gif",
    "Scapular Push-Up":           "videos/3021-jV65tKx.gif",
    "Standing Calf Stretch":      "videos/1377-m0tCHqc.gif",
    "Seated Figure-4 Stretch":    "videos/2567-QY39eBr.gif",
    "Neck Side Stretch":          "videos/1403-x2chWLO.gif",
    "Leg Press":                  "videos/0739-10Z2DXU.gif",
    "Bulgarian Split Squat":      "videos/0410-qx4fgX7.gif",
    "Standing Calf Raise":        "videos/0417-dPmaUaU.gif",
    "Seated Calf Raise":          "videos/0594-bOOdeyc.gif",
    "Kneeling Cable Crunch":      "videos/0175-WW95auq.gif",
    "Cable Pull-Through":         "videos/0196-OM46QHm.gif",
    "Overhead Tricep Extension":  "videos/0430-PdmaD0N.gif",
    "Lying Leg Raise":            "videos/0620-WhuFnR7.gif",
    "Russian Twist":              "videos/0687-XVDdcoj.gif",
    "Crunch":                     "videos/0274-TFqbd8t.gif",
    "Reverse Crunch":             "videos/0872-nCU1Ekp.gif",
    "Flutter Kicks":              "videos/0459-UVo2Qs2.gif",
    "Skull Crusher":              "videos/0060-h8LFzo9.gif",
    "Leg Extension":              "videos/0585-my33uHU.gif",
    "Seated Leg Curl":            "videos/0599-Zg3XY7P.gif",
    "Walking Lunge":              "videos/1460-IZVHb27.gif",
    "Sumo Deadlift":              "videos/0117-KgI0tqW.gif",
    "Arnold Press":               "videos/2137-Xy4jlWA.gif",
    "Dumbbell Preacher Curl":     "videos/0372-jivWf8n.gif",
    "EZ Bar Curl":                "videos/0447-6TG6x2w.gif",
}

# local slug (matches LOCAL_TWO_FRAME in server/db/index.js) -> free-exercise-db id;
# saved as exercises/<slug>/0.jpg and 1.jpg.
TWO_FRAME = {
    "bodyweight-squat":          "Bodyweight_Squat",
    "box-jump":                  "Front_Box_Jump",
    "band-pull-apart":           "Band_Pull_Apart",
    "cat-cow":                   "Cat_Stretch",
    "childs-pose":               "Childs_Pose",
    "arm-circles":               "Arm_Circles",
    "foam-rolling-quads":        "Quadriceps-SMR",
    "foam-rolling-it-band":      "Iliotibial_Tract-SMR",
    "foam-rolling-hamstrings":   "Hamstring-SMR",
    "foam-rolling-upper-back":   "Rhomboids-SMR",
    "rowing-erg":                "Rowing_Stationary",
    "sled-push":                 "Sled_Push",
    "seated-hamstring-stretch":  "Seated_Floor_Hamstring_Stretch",
    "hip-flexor-stretch":        "Kneeling_Hip_Flexor",
    "hip-flexor-lunge-dynamic":  "Standing_Hip_Flexors",
}


def slugify(name: str) -> str:
    cleaned = (name.lower().replace("'", "").replace("(", "").replace(")", "")
               .replace("-", " ").replace("/", " "))
    return "-".join(cleaned.split())


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ok, failed = [], []
    for name, remote_path in MAPPING.items():
        slug = slugify(name)
        local_path = os.path.join(OUT_DIR, f"{slug}.gif")
        url = BASE + remote_path
        try:
            data = fetch(url)
            with open(local_path, "wb") as f:
                f.write(data)
            ok.append((name, slug, len(data)))
            print(f"OK   {name:35s} -> exercises/{slug}.gif ({len(data)//1024}KB)")
        except Exception as e:
            failed.append((name, str(e)))
            print(f"FAIL {name:35s} -> {e}")

    for slug, remote_id in TWO_FRAME.items():
        try:
            os.makedirs(os.path.join(OUT_DIR, slug), exist_ok=True)
            size = 0
            for frame in ("0", "1"):
                data = fetch(f"{TWO_FRAME_BASE}{remote_id}/{frame}.jpg")
                with open(os.path.join(OUT_DIR, slug, f"{frame}.jpg"), "wb") as f:
                    f.write(data)
                size += len(data)
            ok.append((slug, slug, size))
            print(f"OK   {slug:35s} -> exercises/{slug}/0.jpg+1.jpg ({size//1024}KB)")
        except Exception as e:
            failed.append((slug, str(e)))
            print(f"FAIL {slug:35s} -> {e}")

    print(f"\n{len(ok)} downloaded, {len(failed)} failed")
    total_kb = sum(sz for _, _, sz in ok) // 1024
    print(f"Total size: {total_kb}KB")
    if failed:
        print("Failed:", [n for n, _ in failed])


if __name__ == "__main__":
    main()

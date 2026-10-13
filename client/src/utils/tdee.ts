import { toKg, toCm, type WeightUnit, type LengthUnit } from './units';

type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
type Sex = 'male' | 'female' | 'other';

const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary:  1.2,
  light:      1.375,
  moderate:   1.55,
  active:     1.725,
  very_active: 1.9,
};

export function calculateTDEE(params: {
  weight_value: number;
  weight_unit: WeightUnit;
  height_value: number;
  height_unit: LengthUnit;
  birth_date: string;
  sex: Sex;
  activity_level: ActivityLevel;
}): number {
  const { weight_value, weight_unit, height_value, height_unit, birth_date, sex, activity_level } = params;

  const weightKg = toKg(weight_value, weight_unit);
  const heightCm = toCm(height_value, height_unit);
  const age = Math.floor((Date.now() - new Date(birth_date).getTime()) / (365.25 * 24 * 3600 * 1000));

  // Mifflin-St Jeor
  let bmr = 10 * weightKg + 6.25 * heightCm - 5 * age;
  bmr += sex === 'male' ? 5 : -161;

  return Math.round(bmr * ACTIVITY_MULTIPLIERS[activity_level]);
}

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary:   'Sedentary (desk job, no exercise)',
  light:       'Lightly active (1–3 days/week)',
  moderate:    'Moderately active (3–5 days/week)',
  active:      'Very active (6–7 days/week)',
  very_active: 'Extra active (physical job + training)',
};

// Goal offsets applied to TDEE to get calorie target
export const GOAL_OFFSET: Record<string, number> = { lose: -500, lose_mild: -250, maintain: 0, gain: 250, gain_aggressive: 500 };

// NEAT offset above pure sedentary BMR × 1.2 — accounts for background daily movement
// (walking to meetings, stairs, errands) EXCLUDING formal workouts.
// Formal workout calories are added dynamically on workout days in the dashboard.
export const NEAT_OFFSET: Record<string, number> = {
  sedentary: 0,    // desk all day, car commute, minimal movement
  light: 200,      // some walking, ~5–8k steps, office with movement
  moderate: 400,   // active day, ~10k+ steps, stand-up desk, active commute
};

// Evidence-based protein multipliers (g/kg body weight) per goal
// Sources: ISSN Position Stand, Helms et al. 2014, Morton et al. 2018
export const PROTEIN_PER_KG: Record<string, number> = { lose: 2.0, lose_mild: 1.8, maintain: 1.6, gain: 1.8, gain_aggressive: 2.0 };

/** Pure helper — compute evidence-based macro targets from a calorie goal + body weight */
export function computeMacros(
  cal: number,
  weightKg: number | null,
  goal: string,
  sex: string,
): { protein_target_g: number; carbs_target_g: number; fat_target_g: number; fiber_target_g: number } {
  let proteinG: number;
  let fatG: number;

  if (weightKg) {
    const multiplier = PROTEIN_PER_KG[goal] ?? 1.6;
    proteinG = Math.round(weightKg * multiplier);
    // Clamp to 15–40% of calories
    proteinG = Math.max(Math.round(cal * 0.15 / 4), Math.min(Math.round(cal * 0.40 / 4), proteinG));
    // Fat: 0.7 g/kg floor, 20% of calories floor, 35% ceiling
    fatG = Math.max(Math.round(weightKg * 0.7), Math.round(cal * 0.20 / 9));
    fatG = Math.min(fatG, Math.round(cal * 0.35 / 9));
  } else {
    proteinG = Math.round(cal * (goal === 'lose' ? 0.32 : 0.28) / 4);
    fatG = Math.round(cal * 0.25 / 9);
  }

  const carbsG = Math.max(0, Math.round((cal - proteinG * 4 - fatG * 9) / 4));

  // Fiber: 14g / 1000 kcal (IOM), clamped to sex-based range
  const fiberByCalories = Math.round(cal / 1000 * 14);
  const fiberMin = sex === 'female' ? 21 : 30;
  const fiberMax = sex === 'female' ? 25 : 38;
  const fiberG = Math.min(fiberMax, Math.max(fiberMin, fiberByCalories));

  // Sugar: NOT auto-filled. Food DBs only store total sugar (natural + added combined),
  // so a target here would unfairly flag fruit, dairy, etc. Users can set manually if wanted.

  return { protein_target_g: proteinG, carbs_target_g: carbsG, fat_target_g: fatG, fiber_target_g: fiberG };
}

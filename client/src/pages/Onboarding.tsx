import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppStore } from '../store/appStore';
import type { User } from '../types';
import { calculateTDEE, GOAL_OFFSET, NEAT_OFFSET, computeMacros } from '../utils/tdee';
import { toKg } from '../utils/units';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import AscentLogo from '../components/ui/AscentLogo';

const AVATAR_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#06b6d4', '#ef4444'];

type Sex = 'male' | 'female' | 'other';
type ActivityLevel = 'sedentary' | 'light' | 'moderate';
type Goal = 'lose' | 'lose_mild' | 'maintain' | 'gain' | 'gain_aggressive';

interface PersonForm {
  name: string;
  avatar_color: string;
  birth_date: string;
  sex: Sex;
  height_value: string;
  height_unit: 'ft' | 'cm';
  weight_value: string;
  weight_unit: 'lb' | 'kg';
  activity_level: ActivityLevel;
  weight_goal_type: Goal;
}

const BLANK_PERSON = (colorIdx: number): PersonForm => ({
  name: '',
  avatar_color: AVATAR_COLORS[colorIdx % AVATAR_COLORS.length],
  birth_date: '',
  sex: 'male',
  height_value: '',
  height_unit: 'ft',
  weight_value: '',
  weight_unit: 'lb',
  activity_level: 'moderate',
  weight_goal_type: 'maintain',
});

// Creates a user + profile with real calorie/macro targets already computed — the same
// formula Profile.tsx uses (sedentary TDEE + NEAT offset + goal offset, clamped to 1200),
// so the person lands on a populated Dashboard instead of blank targets on day one.
async function createPerson(form: PersonForm) {
  const user = await api.post<User>('/users', { name: form.name.trim(), avatar_color: form.avatar_color });

  const heightValue = Number(form.height_value);
  const weightValue = Number(form.weight_value);
  const weightKg = toKg(weightValue, form.weight_unit);

  const sedentaryTdee = calculateTDEE({
    weight_value: weightValue, weight_unit: form.weight_unit,
    height_value: heightValue, height_unit: form.height_unit,
    birth_date: form.birth_date, sex: form.sex, activity_level: 'sedentary',
  });
  const calorieTarget = Math.max(1200, sedentaryTdee + (NEAT_OFFSET[form.activity_level] ?? 0) + (GOAL_OFFSET[form.weight_goal_type] ?? 0));
  const macros = computeMacros(calorieTarget, weightKg, form.weight_goal_type, form.sex);

  await api.put(`/users/${user.id}/profile`, {
    birth_date: form.birth_date,
    sex: form.sex,
    height_value: heightValue,
    height_unit: form.height_unit,
    activity_level: form.activity_level,
    weight_goal_type: form.weight_goal_type,
    weight_unit: form.weight_unit,
    volume_unit: form.weight_unit === 'kg' ? 'ml' : 'oz',
    length_unit: form.height_unit,
    tdee_estimate: sedentaryTdee,
    calorie_target: calorieTarget,
    ...macros,
  });

  await api.post(`/users/${user.id}/weight-log`, { weight_value: weightValue, weight_unit: form.weight_unit });

  return user;
}

function isPersonComplete(f: PersonForm) {
  return !!(f.name.trim() && f.birth_date && Number(f.height_value) > 0 && Number(f.weight_value) > 0);
}

function PersonStep({ form, setForm, title }: { form: PersonForm; setForm: (f: PersonForm) => void; title: string }) {
  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-white">{title}</p>

      <Input label="Name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Alex" />

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-400">Color</label>
        <div className="flex gap-2">
          {AVATAR_COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => set('avatar_color', c)}
              className="w-7 h-7 rounded-full transition-transform"
              style={{ background: c, transform: form.avatar_color === c ? 'scale(1.15)' : 'scale(1)', outline: form.avatar_color === c ? '2px solid white' : 'none', outlineOffset: '2px' }}
            />
          ))}
        </div>
      </div>

      <Input label="Birth date" type="date" value={form.birth_date} onChange={e => set('birth_date', e.target.value)} />

      <Select label="Sex" value={form.sex} onChange={e => set('sex', e.target.value as Sex)} options={[
        { value: 'male', label: 'Male' },
        { value: 'female', label: 'Female' },
        { value: 'other', label: 'Other' },
      ]} />

      <div className="grid grid-cols-2 gap-2">
        <Input label="Height" type="number" step="0.1" value={form.height_value} onChange={e => set('height_value', e.target.value)} />
        <Select label="Unit" value={form.height_unit} onChange={e => set('height_unit', e.target.value as PersonForm['height_unit'])} options={[
          { value: 'ft', label: 'ft (decimal)' },
          { value: 'cm', label: 'cm' },
        ]} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Input label="Current weight" type="number" step="0.1" value={form.weight_value} onChange={e => set('weight_value', e.target.value)} />
        <Select label="Unit" value={form.weight_unit} onChange={e => set('weight_unit', e.target.value as PersonForm['weight_unit'])} options={[
          { value: 'lb', label: 'lb' },
          { value: 'kg', label: 'kg' },
        ]} />
      </div>

      <Select label="Activity level" value={form.activity_level} onChange={e => set('activity_level', e.target.value as ActivityLevel)} options={[
        { value: 'sedentary', label: 'Sedentary (desk job, no exercise)' },
        { value: 'light', label: 'Lightly active (some walking)' },
        { value: 'moderate', label: 'Active (regular workouts)' },
      ]} />

      <Select label="Goal" value={form.weight_goal_type} onChange={e => set('weight_goal_type', e.target.value as Goal)} options={[
        { value: 'lose', label: '⬇⬇ Cut (−500 kcal/day · ~1 lb/week)' },
        { value: 'lose_mild', label: '⬇ Mild cut (−250 kcal/day · ~0.5 lb/week)' },
        { value: 'maintain', label: '→ Maintain' },
        { value: 'gain', label: '⬆ Lean gain (+250 kcal/day)' },
        { value: 'gain_aggressive', label: '⬆⬆ Bulk (+500 kcal/day)' },
      ]} />
    </div>
  );
}

export default function Onboarding() {
  const qc = useQueryClient();
  const { setActiveUserId } = useAppStore();
  const [step, setStep] = useState<'welcome' | 'person1' | 'addSecond' | 'person2' | 'saving' | 'error'>('welcome');
  const [person1, setPerson1] = useState<PersonForm>(BLANK_PERSON(0));
  const [person2, setPerson2] = useState<PersonForm>(BLANK_PERSON(1));
  const [error, setError] = useState('');

  async function finish(people: PersonForm[]) {
    setStep('saving');
    try {
      const created = [];
      for (const p of people) created.push(await createPerson(p));
      setActiveUserId(created[0].id);
      await qc.invalidateQueries({ queryKey: ['users'] });
      // No further navigation needed — App.tsx's onboarding gate falls away on its own
      // once the users list it's watching comes back non-empty.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — please try again.');
      setStep('error');
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
        <div className="flex flex-col items-center gap-2 pb-2">
          <AscentLogo size={36} />
          <p className="text-xs text-gray-500 text-center">Welcome — let's set up your profile.</p>
        </div>

        {step === 'welcome' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Ascent tracks workouts and meals for one or two people in a household. Let's create the first profile —
              you can add a second person right after.
            </p>
            <Button className="w-full" onClick={() => setStep('person1')}>Get started</Button>
          </div>
        )}

        {step === 'person1' && (
          <div className="space-y-4">
            <PersonStep form={person1} setForm={setPerson1} title="Your profile" />
            <Button className="w-full" disabled={!isPersonComplete(person1)} onClick={() => setStep('addSecond')}>
              Continue
            </Button>
          </div>
        )}

        {step === 'addSecond' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">Add a second person to this household?</p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => finish([person1])}>Just me</Button>
              <Button className="flex-1" onClick={() => setStep('person2')}>Add someone</Button>
            </div>
          </div>
        )}

        {step === 'person2' && (
          <div className="space-y-4">
            <PersonStep form={person2} setForm={setPerson2} title="Second profile" />
            <Button className="w-full" disabled={!isPersonComplete(person2)} onClick={() => finish([person1, person2])}>
              Finish setup
            </Button>
          </div>
        )}

        {step === 'saving' && (
          <p className="text-sm text-gray-400 text-center py-8">Setting up your profile…</p>
        )}

        {step === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-red-400">{error}</p>
            <Button className="w-full" onClick={() => setStep(person2.name ? 'person2' : 'person1')}>Try again</Button>
          </div>
        )}
      </div>
    </div>
  );
}

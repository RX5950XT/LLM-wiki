type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    out.push(String(v));
  };
  for (const v of inputs) walk(v);
  return out.join(' ');
}

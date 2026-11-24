import { useCallback, useState } from 'react';
import { validate, rules } from '../lib/validation';

// Small form state helper: values, per-field errors, "touched" tracking and server-error merging.
export function useForm(initial, fields, ruleSet = rules) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});

  const revalidate = useCallback((next, only) => {
    const all = validate(next, fields, ruleSet);
    setErrors((prev) => {
      const out = { ...prev };
      for (const f of only ?? fields) { if (all[f]) out[f] = all[f]; else delete out[f]; }
      return out;
    });
    return all;
  }, [fields, ruleSet]);

  const setField = useCallback((name, value) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      // Re-check live only after the field was touched (or already shows an error) to avoid nagging while typing.
      if (touched[name] || errors[name]) {
        const dependents = (name === 'password' || name === 'newPassword') && fields.includes('confirmPassword') && (touched.confirmPassword || errors.confirmPassword) ? [name, 'confirmPassword'] : [name];
        revalidate(next, dependents);
      }
      return next;
    });
  }, [touched, errors, fields, revalidate]);

  const blur = useCallback((name) => {
    setTouched((t) => ({ ...t, [name]: true }));
    revalidate(values, [name]);
  }, [values, revalidate]);

  // Validates everything, marks all touched, returns the first invalid field name (or null).
  const validateAll = useCallback(() => {
    const all = validate(values, fields, ruleSet);
    setErrors(all);
    setTouched(Object.fromEntries(fields.map((f) => [f, true])));
    return fields.find((f) => all[f]) ?? null;
  }, [values, fields, ruleSet]);

  const setServerErrors = useCallback((map = {}) => {
    setErrors((prev) => ({ ...prev, ...map }));
    setTouched((t) => ({ ...t, ...Object.fromEntries(Object.keys(map).map((k) => [k, true])) }));
    return fields.find((f) => map[f]) ?? null;
  }, [fields]);

  const reset = useCallback((next) => { setValues(next); setErrors({}); setTouched({}); }, []);

  return { values, errors, setField, blur, validateAll, setServerErrors, reset, setValues };
}

-- 095: El Rehab is one compound. The three phase entries (Group 8, Phase 1, Phase 2) become aliases of "El Rehab City";
-- units on a phase place move to it, and the phase text goes into the unit's notes. Does nothing where the parent is missing.
DO $$
DECLARE parent record; ph record;
BEGIN
  SELECT id, name_en, name_ar INTO parent FROM map_places WHERE name_en = 'El Rehab City' ORDER BY approved DESC LIMIT 1;
  IF parent.id IS NULL THEN RETURN; END IF;
  UPDATE map_places SET approved = true,
    aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['el rehab 1','rehab1','el rehab 2','rehab2','al rehab mgmo3a 8','el rehab group 8','rehab group 8']))
   WHERE id = parent.id;
  FOR ph IN SELECT id, name_en FROM map_places WHERE name_en LIKE 'El Rehab City - %' AND id <> parent.id LOOP
    UPDATE listings SET place_id = parent.id, compound_state = NULL,
        compound = coalesce(parent.name_ar, parent.name_en), compound_en = parent.name_en,
        details = jsonb_set(coalesce(details, '{}'::jsonb), '{notes}',
          to_jsonb(concat_ws(' — ', nullif(details->>'notes', ''), substring(ph.name_en FROM 'El Rehab City - (.*)$'))))
     WHERE place_id = ph.id;
    DELETE FROM map_places WHERE id = ph.id;
  END LOOP;
END $$;

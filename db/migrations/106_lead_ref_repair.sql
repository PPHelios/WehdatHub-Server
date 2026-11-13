-- Lead numbers: an agency whose counter fell behind its highest lead number (a reset) could not add a lead.
UPDATE agencies a SET lead_ref_seq = m.mx
  FROM (SELECT agency_id, max(ref) AS mx FROM leads GROUP BY agency_id) m
 WHERE m.agency_id = a.id AND a.lead_ref_seq < m.mx;

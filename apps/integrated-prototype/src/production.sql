-- Production views share the existing scene and shooting-day identities.
CREATE TABLE IF NOT EXISTS production_revisions (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(org_id,work_id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS production_characters (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  short_name TEXT, actor_name TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,name),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS production_locations (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  address TEXT, floor TEXT, green_room TEXT, parking TEXT, facilities TEXT, contact TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,name),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS production_location_plans (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, location_key TEXT NOT NULL,
  strokes_json TEXT NOT NULL CHECK(json_valid(strokes_json) AND json_type(strokes_json)='array' AND length(strokes_json)<=262144),
  PRIMARY KEY(org_id,work_id,location_key),
  FOREIGN KEY(org_id,work_id,location_key) REFERENCES production_locations(org_id,work_id,key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS production_scene_details (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL,
  page_eighths INTEGER CHECK(page_eighths IS NULL OR page_eighths>=0),
  estimated_minutes INTEGER CHECK(estimated_minutes IS NULL OR estimated_minutes>0),
  location_key TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,scene_id),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,location_key) REFERENCES production_locations(org_id,work_id,key)
);
CREATE TABLE IF NOT EXISTS production_appearances (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, character_key TEXT NOT NULL,
  PRIMARY KEY(org_id,work_id,scene_id,character_key),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);
CREATE TABLE IF NOT EXISTS production_looks (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, character_key TEXT NOT NULL,
  label TEXT NOT NULL, makeup TEXT, props TEXT, shoes TEXT, accessories TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,character_key,label),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);
CREATE TABLE IF NOT EXISTS production_scene_looks (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, look_key TEXT NOT NULL,
  PRIMARY KEY(org_id,work_id,scene_id,look_key),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,look_key) REFERENCES production_looks(org_id,work_id,key)
);
CREATE TABLE IF NOT EXISTS production_day_slots (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, day_id INTEGER NOT NULL, key TEXT NOT NULL,
  after_scene_order INTEGER NOT NULL CHECK(after_scene_order>=0), kind TEXT NOT NULL CHECK(kind IN ('move','meal','wrap','prep','other')),
  label TEXT NOT NULL, planned_start TEXT, planned_end TEXT, actual_start TEXT, actual_end TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,day_id,key),
  CHECK(planned_end IS NULL OR planned_start IS NULL OR planned_end>planned_start),
  CHECK(actual_end IS NULL OR actual_start IS NULL OR actual_end>actual_start),
  FOREIGN KEY(org_id,work_id,day_id) REFERENCES shooting_days(org_id,work_id,id)
);
CREATE TABLE IF NOT EXISTS production_calls (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, day_id INTEGER NOT NULL, character_key TEXT NOT NULL,
  call_time TEXT, ready_time TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,day_id,character_key),
  FOREIGN KEY(org_id,work_id,day_id) REFERENCES shooting_days(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);

-- Git repo names, comma-joined, lowercase, e.g. 'cradle,cradle-web'. One project per repo.
ALTER TABLE projects ADD COLUMN repos TEXT NOT NULL DEFAULT '';

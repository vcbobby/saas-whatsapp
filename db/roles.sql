-- Se ejecuta UNA sola vez, como superusuario, con las variables owner_pw y user_pw.
--   app_owner: dueño de las tablas. Solo lo usan las migraciones.
--   app_user : lo usa la aplicación. No es dueño de nada, por eso las reglas RLS le aplican.

CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE app_user LOGIN PASSWORD :'user_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO app_owner, app_user;
ALTER DATABASE :"DBNAME" OWNER TO app_owner;

ALTER SCHEMA public OWNER TO app_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;

-- Toda tabla que cree app_owner queda disponible para app_user (sujeta a RLS).
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

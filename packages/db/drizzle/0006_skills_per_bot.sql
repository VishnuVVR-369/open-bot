DROP INDEX "skills_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "skills_shared_name_unique" ON "skills" USING btree ("name") WHERE "skills"."bot_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_bot_name_unique" ON "skills" USING btree ("bot_id","name") WHERE "skills"."bot_id" is not null;
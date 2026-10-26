-- A member's followers: follower counts, follower lists and the network line
-- on member cards look follows up by following_id, which the unique
-- (follower_id, following_id) index can't serve.
CREATE INDEX "follows_following_id_idx" ON "follows"("following_id");

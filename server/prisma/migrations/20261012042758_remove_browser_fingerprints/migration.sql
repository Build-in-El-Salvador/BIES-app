-- Device fingerprinting is gone (Apple forbids deriving data from a device to
-- identify it, and the privacy notice says BIES doesn't do it). Ban-evasion
-- detection was its only use. This deletes the stored fingerprints, each with
-- an IP address and a user agent.
/*
  Warnings:

  - You are about to drop the `browser_fingerprints` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "browser_fingerprints";
PRAGMA foreign_keys=on;

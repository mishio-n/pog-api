import { Course, Grade, PrismaClient } from "@prisma/client";
import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import fetch from "node-fetch";
import puppeteer from "puppeteer";
import { match } from "ts-pattern";

const prisma = new PrismaClient();

export const handler = async (
  event: APIGatewayEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  const body = JSON.parse(
    Buffer.from(event.body ?? "", "base64").toString("utf-8")
  );

  const raceId = body.raceId;

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`,
  });

  const page = await browser.newPage();

  await page.goto(
    `https://race.netkeiba.com/race/result.html?race_id=${raceId}`
  );

  const raceTitle = await page.$("div.RaceName");
  if (raceTitle === null) {
    throw new Error("raceTitle is not found");
  }

  const title = await page.$eval("div.RaceName", (el) => el.textContent);
  if (title === null) {
    throw new Error("title is not found");
  }

  const raceData = await page.$eval(
    "div.RaceData01 > span",
    (el) => el.textContent
  );
  if (raceData === null) {
    throw new Error("raceData is not found");
  }

  const course = raceData.includes("芝") ? Course.TURF : Course.DART;

  let gradeInfo = "";
  try {
    gradeInfo = await raceTitle.$eval(
      "span.Icon_GradeType",
      (el) => el.className
    );
  } catch (error) {
    // グレードなしはスキップ
  }
  const gradeMathced = gradeInfo.match(/Icon_GradeType(\d)$/)?.[1];
  const grade = match(gradeMathced)
    .with("1", () => Grade.G1)
    .with("2", () => Grade.G2)
    .with("3", () => Grade.G3)
    .otherwise(() => Grade.NORMAL);

  const dd = await page.$eval(
    "#RaceList_DateList > dd.Active > a",
    (el) => el.href
  );

  const dateLink = new URL(dd);
  const date = dateLink.searchParams.get("kaisai_date");
  if (date === null) {
    throw new Error("date is not found");
  }

  const horses = await page.$$eval(
    "table.RaceTable01 > tbody > tr > td.Horse_Info > span > a",
    (el) => el.map((e) => e.textContent!)
  );
  const oddsList = await page.$$eval(
    "table.RaceTable01 > tbody > tr > td.Odds.Txt_R > span",
    (el) => el.map((e) => +e.textContent!)
  );

  const prizesText = await page.$$eval(
    "div.RaceData02 > span",
    (el) => el.at(-1)?.textContent
  );
  if (!prizesText) {
    throw new Error();
  }

  const p = prizesText.match(/([0-9,]+)/g);
  if (!p) {
    throw new Error("prizes is not found");
  }
  const prizes = p[0].split(",");

  const registerdHorses = await prisma.horse.findMany({
    include: { owners: true },
  });
  const targetHorses = registerdHorses.filter(({ name }) =>
    horses.includes(name)
  );

  const results = targetHorses.map((horse) => {
    const result = horses.indexOf(horse.name) + 1;
    const point = result > 5 ? 0 : +prizes[result - 1];

    return {
      name: title.trim(),
      url: `https://db.netkeiba.com/race/${raceId}/`,
      date,
      course,
      grade,
      result,
      horse,
      point,
      odds: oddsList[result - 1],
    };
  });
  await browser.close();

  for (const result of results) {
    await prisma.race.create({
      data: {
        name: result.name,
        odds: result.odds,
        point: result.point,
        result: result.result,
        horseId: result.horse.id,
        date: result.date,
        url: result.url,
        course: result.course,
        grade: result.grade,
      },
    });
    const owners = await prisma.owner.findMany({
      where: { horses: { some: { id: result.horse.id } } },
    });

    const paths = owners.flatMap((owner) => [
      `/${owner.seasonId}/${owner.ruleId}/`,
      `/${owner.seasonId}/${owner.ruleId}/${owner.id}`,
      `/${owner.seasonId}/${owner.ruleId}/${owner.id}/${result.horse.id}`,
    ]);

    await fetch("https://ouchi-pog.vercel.app/api/revalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        body: JSON.stringify({
          paths,
        }),
      },
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      results,
    }),
  };
};

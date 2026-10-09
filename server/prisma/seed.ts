import { PrismaClient } from '@prisma/client';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encryptPrivateKey } from '../src/services/crypto.service';

const prisma = new PrismaClient();

// ─── Seed Data (from existing mockProfiles.js) ───

const builders = [
    {
        name: 'Maria Santos',
        company: 'Volcano Energy Solutions',
        title: 'Founder & CEO',
        bio: 'Pioneering renewable energy mining infrastructure. We convert geothermal waste into hashrate.',
        location: 'Santa Ana, El Salvador',
        tags: ['Mining', 'Energy', 'Infrastructure'],
        avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'David Li',
        company: 'Lightning POS',
        title: 'CTO',
        bio: 'Building the simplest Point of Sale system for merchants in El Zonte and beyond.',
        location: 'El Zonte, La Libertad',
        tags: ['Fintech', 'Lightning', 'Payments'],
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Elena Rodriguez',
        company: 'Educación Bitcoin',
        title: 'Director',
        bio: 'Empowering the next generation through Bitcoin education in public schools.',
        location: 'San Salvador',
        tags: ['Education', 'Non-Profit', 'Community'],
        avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Carlos Mendez',
        company: 'AgriBit',
        title: 'Co-Founder',
        bio: 'Tokenizing coffee production for small farmers using Liquid Network.',
        location: 'Apaneca, Ahuachapán',
        tags: ['Agriculture', 'Tokenization', 'Liquid'],
        avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Sarah Chen',
        company: 'BitDevs SV',
        title: 'Organizer',
        bio: 'Connecting developers and fostering open source contribution in Central America.',
        location: 'San Salvador',
        tags: ['Developer Tools', 'Community', 'Open Source'],
        avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
];

const investors = [
    {
        name: 'Freedom Capital',
        company: 'Freedom Capital',
        title: 'Venture Fund',
        bio: 'Early stage Bitcoin-only venture fund focused on emerging markets and freedom tech.',
        location: 'San Salvador (HQ)',
        tags: ['Seed', 'Series A', 'Infrastructure'],
        avatar: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Global Macro Ventures',
        company: 'GMV',
        title: 'Family Office',
        bio: 'Allocating capital to hard assets and sovereign infrastructure projects.',
        location: 'New York / El Salvador',
        tags: ['Real Estate', 'Mining', 'Growth'],
        avatar: 'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Lightning Ventures',
        company: 'Lightning Ventures',
        title: 'Angel Syndicate',
        bio: 'Backing the best founders building on the Lightning Network.',
        location: 'Distributed',
        tags: ['Lightning', 'Consumer', 'Pre-Seed'],
        avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'El Zonte Capital',
        company: 'El Zonte Capital',
        title: 'Micro VC',
        bio: 'Hyper-local fund supporting businesses in the Bitcoin Beach ecosystem.',
        location: 'El Zonte',
        tags: ['Local Business', 'Tourism', 'Services'],
        avatar: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
    {
        name: 'Sovereign Wealth',
        company: 'Individual Angel',
        title: 'Angel Investor',
        bio: 'Looking for high-risk, high-reward opportunities in the citadel.',
        location: 'Bitcoin City',
        tags: ['Angel', 'Tech', 'Privacy'],
        avatar: 'https://images.unsplash.com/photo-1507679799987-97341b64e727?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
    },
];

const sampleProjects = [
    {
        title: 'Volcano Mining Facility',
        description: 'A geothermal-powered Bitcoin mining facility leveraging El Salvador\'s volcanic activity. Phase 1 targets 10MW capacity with plans to scale to 50MW.',
        category: 'ENERGY',
        stage: 'MVP',
        fundingGoal: 5000000,
        thumbnail: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
        tags: ['Mining', 'Energy', 'Geothermal'],
    },
    {
        title: 'Lightning POS Terminal',
        description: 'A plug-and-play Lightning Network payment terminal for small merchants. No technical knowledge required. Just connect and accept Bitcoin.',
        category: 'FINTECH',
        stage: 'GROWTH',
        fundingGoal: 500000,
        thumbnail: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
        tags: ['Fintech', 'Lightning', 'Payments'],
    },
    {
        title: 'Bitcoin Schools Program',
        description: 'Bringing Bitcoin financial literacy to 100 public schools across El Salvador. Curriculum includes savings, Lightning payments, and digital security.',
        category: 'EDUCATION',
        stage: 'IDEA',
        fundingGoal: 250000,
        thumbnail: 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
        tags: ['Education', 'Community'],
    },
    {
        title: 'CoffeeChain',
        description: 'Tokenizing El Salvador\'s premium coffee supply chain on Liquid Network. Fair pricing for farmers, transparent sourcing for buyers.',
        category: 'AGRICULTURE',
        stage: 'MVP',
        fundingGoal: 750000,
        thumbnail: 'https://images.unsplash.com/photo-1447933601403-0c6688de566e?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
        tags: ['Agriculture', 'Tokenization', 'Supply Chain'],
    },
    {
        title: 'Bitcoin Beach Resort',
        description: 'A Bitcoin-native luxury resort in El Zonte. All services priced in sats, with Lightning-powered amenities and experiences.',
        category: 'TOURISM',
        stage: 'IDEA',
        fundingGoal: 2000000,
        thumbnail: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80',
        tags: ['Tourism', 'Real Estate', 'Hospitality'],
    },
];

async function main() {
    // The seed deletes every user before inserting test data.
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Refusing to seed: NODE_ENV is production and seeding deletes all users');
    }

    console.log('🌱 Seeding database...\n');

    // Clear existing data
    await prisma.project.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();

    console.log('  Cleared existing data');

    // Create builders
    const createdBuilders = [];
    for (const builder of builders) {
        const sk = generateSecretKey();
        const pk = getPublicKey(sk);
        const skHex = Buffer.from(sk).toString('hex');

        const user = await prisma.user.create({
            data: {
                email: `${builder.name.toLowerCase().replace(/\s+/g, '.')}@bies.test`,
                nostrPubkey: pk,
                encryptedPrivkey: encryptPrivateKey(skHex),
                role: 'BUILDER',
                profile: {
                    create: {
                        name: builder.name,
                        bio: builder.bio,
                        avatar: builder.avatar,
                        location: builder.location,
                        company: builder.company,
                        title: builder.title,
                        tags: JSON.stringify(builder.tags),
                        skills: JSON.stringify([]),
                    },
                },
            },
        });

        createdBuilders.push(user);
        console.log(`  ✅ Builder: ${builder.name} (${user.email})`);
    }

    // Create investors
    for (const investor of investors) {
        const sk = generateSecretKey();
        const pk = getPublicKey(sk);
        const skHex = Buffer.from(sk).toString('hex');

        const user = await prisma.user.create({
            data: {
                email: `${investor.name.toLowerCase().replace(/\s+/g, '.')}@bies.test`,
                nostrPubkey: pk,
                encryptedPrivkey: encryptPrivateKey(skHex),
                role: 'INVESTOR',
                profile: {
                    create: {
                        name: investor.name,
                        bio: investor.bio,
                        avatar: investor.avatar,
                        location: investor.location,
                        company: investor.company,
                        title: investor.title,
                        tags: JSON.stringify(investor.tags),
                        skills: JSON.stringify([]),
                    },
                },
            },
        });

        console.log(`  ✅ Investor: ${investor.name} (${user.email})`);
    }

    // Create sample projects (assigned to builders)
    for (let i = 0; i < sampleProjects.length; i++) {
        const project = sampleProjects[i];
        const owner = createdBuilders[i % createdBuilders.length];

        await prisma.project.create({
            data: {
                title: project.title,
                description: project.description,
                category: project.category,
                stage: project.stage,
                fundingGoal: project.fundingGoal,
                thumbnail: project.thumbnail,
                tags: JSON.stringify(project.tags),
                ownerId: owner.id,
            },
        });

        console.log(`  ✅ Project: ${project.title}`);
    }

    // Create admin user
    const adminSk = generateSecretKey();
    const adminPk = getPublicKey(adminSk);
    const adminSkHex = Buffer.from(adminSk).toString('hex');
    await prisma.user.create({
        data: {
            email: 'admin@bies.test',
            nostrPubkey: adminPk,
            encryptedPrivkey: encryptPrivateKey(adminSkHex),
            role: 'ADMIN',
            profile: {
                create: {
                    name: 'BIES Admin',
                    bio: 'Platform Administrator',
                    company: 'BIES',
                    title: 'Admin',
                    tags: JSON.stringify(['admin']),
                    skills: JSON.stringify([]),
                },
            },
        },
    });
    console.log('  ✅ Admin: admin@bies.test');

    console.log('\n🎉 Seeding complete!');
    console.log('\n📋 Sign in with any seeded address (admin: admin@bies.test).');
    console.log('   Without RESEND_API_KEY, the server prints each sign-in code to its log.');
}

main()
    .catch((e) => {
        console.error('Seed error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

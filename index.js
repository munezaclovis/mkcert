import Docker from 'dockerode';
import YAML from 'yaml';
import { createCA, createCert } from 'mkcert';
import { readFile, writeFile } from 'node:fs/promises';

const options = {
    ca: {
        key: './files/ca/rootCA-key.pem',
        cert: './files/ca/rootCA.pem',
    },
    sites: {
        certs: './files/certs',
        tls: './files/traefik/tls.yml',
    },
};

let ca = {
    key: await readFile(options.ca.key, 'utf-8').catch(() => void 0),
    cert: await readFile(options.ca.cert, 'utf-8').catch(() => void 0),
};

if (!ca.key || !ca.cert) {
    ca = await createCA({
        countryCode: 'US',
        organizationName: 'mkcert development CA',
        locality: 'San Francisco',
        state: 'California',
        validity: 365,
        organization: 'mkcert development',
    });

    await writeFile(options.ca.key, ca.key);
    console.log(`CA Private Key: ${options.ca.key}`);

    await writeFile(options.ca.cert, ca.cert);
    console.log(`CA Certificate: ${options.ca.cert}`);
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function generateCert(domains, ca) {
    return await createCert({
        ca: { cert: ca.cert, key: ca.key },
        email: 'admin@localhost',
        organization: 'mkcert development',
        domains: domains,
        validity: 365,
    });
}

async function checkLabelChanges() {
    try {
        const containers = await docker.listContainers({
            filters: {
                status: ['running'],
                label: ['traefik.enable=true', 'mkcert.domains'],
            },
        });

        /**
         * @type {Map<string, { cert: string, key: string }>}
         */
        const certificates = new Map();

        for (const container of containers) {
            const domains = new Set(container.Labels['mkcert.domains'].split(',').map((domain) => domain.trim()));

            const certs = await generateCert([...domains.values()], ca);

            const names = {
                certFile: `${options.sites.certs}/${container.Names[0]}.pem`,
                keyFile: `${options.sites.certs}/${container.Names[0]}-key.pem`,
            };

            console.log(`Creating Certificate for ${container.Names[0]}`);
            await writeFile(names.certFile, certs.cert);
            console.log(`Certificate: ${names.certFile}`);

            await writeFile(names.keyFile, certs.key);
            console.log(`Private Key: ${names.keyFile}`);

            certificates.set(container.Id, names);
        }

        const yamlContents = YAML.stringify({
            tls: {
                certificates: [...certificates.values()],
            },
        });

        await writeFile(options.sites.tls, yamlContents);
    } catch (error) {
        console.error('Error checking label changes:', error);
    }
}

// Run periodic label check every 10 seconds
while (true) {
    console.log('Checking for label changes...');
    console.log('\n');
    await checkLabelChanges();
    console.log('\n');
    await new Promise((resolve) => setTimeout(resolve, 10000));
}

# Traefik mkcert

## Overview

This is a Docker image designed for development purposes. It automatically generates SSL certificates for your local projects using mkcert. This setup is optimized for use with Traefik and serves as an alternative to Let's Encrypt, which does not support local domains such as `.test`, `.local`, `.docker`, etc.

## Docker Image

The image: `ghcr.io/munezaclovis/mkcert`

### Configuration example

```yaml
services:
    traefik:
        # Your Traefik configurations here...
        command:
            - '--providers.file.directory=/etc/traefik/conf'
            - '--providers.file.watch=true'
            # additional commands...
        volumes:
            - './dynamic:/etc/traefik'

    mkcert:
        image: ghcr.io/munezaclovis/mkcert
        volumes:
            - './dynamic/certs:/app/files/certs' # Location for generated certificates
            - './dynamic/ca:/app/files/ca' # Directory for rootCA files used to sign certificates
            - './dynamic/conf/tls.yml:/app/files/traefik/tls.yml' # Traefik configuration for certificates

        environment:
            - CHECK_INTERVAL=10000
            - CERT_DIR=/etc/traefik/certs/ # !!!REQUIRED!!! Path where certificates are mounted in the Traefik container
```

## Usage

If you want to generate SSL certificates for a specific service or container, even if it resides in another folder or project, you can still use the mkcert container. Simply ensure that the appropriate directories are mounted and the `mkcert.domains` and `traefik.enable=true` label is configured correctly for the target service.

```
traefik.enable=true
mkcert.domains=example.test,*.example.test
```

#### Example:

```yaml
myservice:
    image: your-service-image
    labels:
        - 'traefik.enable=true'
        - 'traefik.http.routers.myservice.rule=Host(`myservice.test`)'
        - 'traefik.http.routers.myservice.entrypoints=https'
        - 'traefik.http.routers.myservice.tls=true'
        - 'mkcert.domains=myservice.test,*.myservice.test'
```

## Mounting Files

To access the generated files, mount the `/app/files/` directory. Within this directory:

-   `/app/files/ca`: Contains `rootCA.pem` and `rootCA-key.pem`. These are automatically generated, but if you already have root certificates, mount them here.
-   `/app/files/certs`: Contains all generated certificates.
-   `/app/files/traefik`: Contains the generated `tls.yml` file for Traefik configuration.

## Environment Variables

Since the mkcert image doesn’t know where the certificates will be mounted in Traefik, you MUST provide the `CERT_DIR` variable. This variable is used to construct the full path when generating the `tls.yml` file, ensuring Traefik can locate and load the certificates.

## Auto Trust the Generated SSL Certificates

To have your system automatically trust the generated certificates, you'll need install the rootCA on your local machine.

For MacOS, you can do that through `KeyChain Access`
For Windows and Linux, You can use google and chatgpt to help with that. I am not familiar with those operating systems
